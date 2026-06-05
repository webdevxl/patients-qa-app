import { ChatOpenAI } from '@langchain/openai';
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import {
  observationFilterSchema,
  medicationFilterSchema,
} from './tools/find-patients.tool';

/**
 * Safe fallback string (used verbatim per the spec) for when no patient can be resolved.
 * `QaService` returns this whenever extraction yields nothing routable, a retrieval matches
 * nothing, or extraction itself fails.
 */
export const SAFE_FALLBACK =
  'I cannot find a matching patient in your cohort, or I cannot answer this question based on the available records.';

/**
 * The single, unified extraction schema. Its fields are exactly the UNION of the find_patients
 * tool's lookups ({patientId, name} for identity; {conditionQuery, allergyQuery} for attribute),
 * so the extracted object passes straight into `findPatients` with zero reshaping.
 *
 * The model only ever EXTRACTS these fields — it never decides which retrieval to run and never
 * answers the question. Routing is deterministic code in QaService (identity wins). Constraining
 * the model to this fixed object (vs. free tool-calling / free text) is also the core
 * prompt-injection defense: the only thing the model can emit is this fixed set of search fields.
 *
 * Fields are `.nullable()` (NOT `.optional()`): @langchain/openai v1's `withStructuredOutput`
 * uses OpenAI's strict structured-outputs mode, where every key must be present — optionality is
 * expressed as `null`. The model sets the fields that apply and returns `null` for the rest;
 * routing in QaService treats null/empty identically.
 */
export const extractionSchema = z.object({
  patientId: z
    .string()
    .nullable()
    .describe(
      'The patient UUID if the message contains one, e.g. ' +
        '"9ec974ce-91d6-48e3-a8af-796c05348080". Never invent one.',
    ),
  name: z
    .string()
    .nullable()
    .describe(
      "A person's name (full, first, or last) when the message is about ONE specific patient, " +
        "e.g. 'Adolfo Ricker'. Resolve pronouns/references (\"his/her/their\", \"that patient\") " +
        'to the patient established in earlier turns and put that name here. Identity wins: set ' +
        'this even when an allergy/condition is also mentioned ("Is John Smith allergic to ' +
        'penicillin?") and leave the condition/allergy fields empty.',
    ),
  conditionQuery: z
    .string()
    .nullable()
    .describe(
      "A disease/diagnosis/symptom to search for ACROSS patients, e.g. 'diabetes', 'dementia', " +
        "'chronic pain'. The clinical concept only — never a name or ID. Omit for a specific " +
        'named patient.',
    ),
  allergyQuery: z
    .string()
    .nullable()
    .describe(
      "A substance from an 'allergic to X' search ACROSS patients, e.g. 'penicillin', 'sulfa'. " +
        'The substance only — never a name or ID. An allergy is NOT a diagnosis: route "allergic ' +
        'to ..." here, never to conditionQuery. Combine with conditionQuery when the message asks ' +
        'about both ("diabetics allergic to penicillin"). Omit for a specific named patient.',
    ),
  observationFilter: observationFilterSchema
    .nullable()
    .describe(
      'A numeric filter over a vital sign / measurement to search ACROSS patients, e.g. "weight ' +
        'over 200 lbs" ⇒ { metric: "Weight", operator: "gt", value: 200 }. Use the metric\'s ' +
        'native unit (Lbs, Inches, °F, mg/dL, bpm, mmHg, %, Breaths/min, pain 0–10) and emit the ' +
        'raw number — do NOT convert units. For BloodPressure set component (default systolic). ' +
        'Set this ALONGSIDE conditionQuery/allergyQuery when both are asked ("diabetics with ' +
        'heart rate over 100"). Null when no measurement comparison is requested.',
    ),
  medicationFilter: medicationFilterSchema
    .nullable()
    .describe(
      'Set when the message asks which patients TAKE a drug, optionally narrowed by dose/form/' +
        'route ("who is on Tylenol?" ⇒ { names: ["Tylenol","acetaminophen"] }; "patients on 325 ' +
        'mg acetaminophen tablets" ⇒ { names: ["acetaminophen","Tylenol"], doseText: "325 MG", ' +
        'form: "Tablet" }; "injectable insulin" ⇒ { names: ["insulin"], route: "Injection" }). ' +
        'names MUST list the drug PLUS its brand/generic synonyms for the SAME drug — never a ' +
        'therapeutic class (for "painkillers"/"antibiotics" leave this null). Set this ALONGSIDE ' +
        'conditionQuery/allergyQuery/observationFilter when combined ("diabetics on metformin"). ' +
        'Null when no specific medication is named.',
    ),
});

export type Extraction = z.infer<typeof extractionSchema>;

/** The all-null extraction: nothing identified, nothing to search → routes to the safe fallback. */
export const EMPTY_EXTRACTION: Extraction = {
  patientId: null,
  name: null,
  conditionQuery: null,
  allergyQuery: null,
  observationFilter: null,
  medicationFilter: null,
};

/**
 * One prior conversation turn the client sends so the extractor can resolve follow-ups
 * ("what about his allergies?"). Only `user`/`assistant` are accepted; assistant content is a
 * COMPACT resolution summary (see `QaResult.contextSummary`), never a full patient record.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Keep at most this many prior turns (history is for coreference, not full recall). */
const MAX_HISTORY_TURNS = 6;
/** Cap any single turn's content to bound tokens + injection surface. */
const MAX_CONTENT_CHARS = 500;

/**
 * Harden client-supplied history before it reaches the model:
 *   • whitelist roles to user/assistant (drops any injected `system`/`tool` turn),
 *   • coerce content to a trimmed, length-capped string,
 *   • keep only the most recent MAX_HISTORY_TURNS.
 * The extractor still prepends its OWN trusted system prompt, so a poisoned history can at most
 * nudge the extracted search fields — it can never replace the instructions or bypass routing.
 */
export function sanitizeAndTrim(history: ChatTurn[] | undefined): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (turn): turn is ChatTurn =>
        !!turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.trim().length > 0,
    )
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim().slice(0, MAX_CONTENT_CHARS),
    }))
    .slice(-MAX_HISTORY_TURNS);
}

/**
 * The extraction system prompt. (A/B prompt variants will be added later — for now a single
 * prompt; keep it targeting `extractionSchema` so any future variant is a drop-in.)
 */
const EXTRACTION_SYSTEM_PROMPT = `You extract structured search parameters from a clinician's chat message. You do NOT answer the question — another layer retrieves the records. Read the latest user message (use earlier turns only to resolve references) and fill ONLY the fields that apply:

- patientId: a patient UUID, if the message contains one. Never invent one.
- name: a person's name when the message is about ONE specific patient (full, first, or last). Resolve pronouns/references ("he/she/they", "that patient", "their meds") to the patient established in earlier turns and put that name here. Identity takes priority: if the message names a specific patient AND mentions a condition/allergy ("Is John Smith allergic to penicillin?"), set name and leave the condition/allergy fields empty.
- conditionQuery: a disease, diagnosis, or symptom to search ACROSS patients ("which patients have diabetes?"). The clinical concept only. Leave empty for a specific named patient.
- allergyQuery: a substance from an "allergic to X" search ACROSS patients ("who is allergic to penicillin?"). The substance only. An allergy is NOT a diagnosis — route "allergic to ..." here, never to conditionQuery. Set BOTH conditionQuery and allergyQuery when the message combines them ("diabetics allergic to penicillin").
- observationFilter: a numeric comparison over a vital sign / measurement ACROSS patients ("weight over 200 lbs", "heart rate above 100", "oxygen saturation below 90"). metric is one of PainLevel, Weight, Height, BloodPressure, BloodSugar, HeartRate, Temperature, RespiratoryRate, OxygenSaturation; operator is gt/gte/lt/lte/eq/between (value2 only for between); value is the raw number in the metric's NATIVE unit (Lbs, Inches, °F, mg/dL, bpm, mmHg, %, Breaths/min, pain 0–10) — never convert units. For BloodPressure set component to systolic or diastolic (default systolic). Set observationFilter ALONGSIDE conditionQuery/allergyQuery when the message combines them ("diabetics with heart rate over 100"). Leave null when no measurement comparison is asked.
- medicationFilter: which patients TAKE a drug ("who is on Tylenol?", "patients on 325 mg acetaminophen tablets", "injectable insulin"), optionally narrowed by dose/form/route. names = the drug PLUS its brand/generic synonyms for the SAME drug ("Tylenol" → ["Tylenol","acetaminophen"]); NEVER a therapeutic class (for "painkillers"/"antibiotics" leave medicationFilter null). doseText = the dose as a label prints it (number + space + uppercase unit, e.g. "325 MG"; convert "325 milligrams" → "325 MG"), else null. form = EXACTLY one of Tablet, Capsule, Solution, Suspension, Suppository, Cream, Ointment, Gel, Lotion, Spray, Inhaler ("pill" → Tablet), else null. route = EXACTLY one of Oral, Injection, Ophthalmic, Topical, Rectal, Inhalation, Transdermal, Nasal ("by mouth" → Oral, "shot"/"IV" → Injection, "eye" → Ophthalmic), else null. Set medicationFilter ALONGSIDE conditionQuery/allergyQuery/observationFilter when combined ("diabetics on metformin"). Leave null when no specific medication is named.

If the message identifies no specific patient and asks for no searchable condition, allergy, measurement, or medication, leave every field empty.`;

/** Token usage for one extraction call (best-effort; surfaced for observability). */
export interface ExtractionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** What the extractor returns: the parsed fields plus best-effort token usage. */
export interface ExtractionResult {
  extraction: Extraction;
  usage?: ExtractionUsage;
  /** True when the model refused / returned unparseable output and we substituted EMPTY_EXTRACTION. */
  refused?: boolean;
}

export interface PatientQaExtractor {
  extract(question: string, history?: ChatTurn[]): Promise<ExtractionResult>;
}

/** Nest DI token for the extractor, so `QaService` receives a mockable, config-driven instance. */
export const PATIENT_QA_EXTRACTOR = Symbol('PATIENT_QA_EXTRACTOR');

/** Pull token usage off the raw AIMessage (`usage_metadata`), if present. */
export function readUsage(raw: BaseMessage): ExtractionUsage | undefined {
  const usage = (raw as AIMessage).usage_metadata;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    totalTokens: usage.total_tokens,
  };
}

/** Default chat model + sampling for the extractor; overridable via ConfigService at the DI layer. */
export const DEFAULT_CHAT_MODEL = 'gpt-4o-mini';
export const DEFAULT_CHAT_TEMPERATURE = 0;
// Client-side resilience so a slow/stalled OpenAI call fails FAST into the safe-fallback path
// instead of inheriting the SDK's ~10-minute default and fanning out unbounded under load. Worst-
// case wall time ≈ timeout × (1 + maxRetries), so keep retries low.
const CHAT_TIMEOUT_MS = 15_000;
const CHAT_MAX_RETRIES = 2;
const CHAT_MAX_CONCURRENCY = 8;

/** Tuning knobs for the chat model (model + temperature); resilience is fixed in {@link createChatModel}. */
export interface ChatModelOptions {
  model?: string;
  temperature?: number;
}

/**
 * Single place the OpenAI chat client is constructed (the extractor here + the Studio graph), so the
 * model name, temperature, and resilience config live in ONE spot. Undefined options fall back to the
 * defaults. Reads OPENAI_API_KEY from the environment (kept Nest-free so Studio/scripts can reuse it).
 */
export function createChatModel(options: ChatModelOptions = {}): ChatOpenAI {
  return new ChatOpenAI({
    model: options.model ?? DEFAULT_CHAT_MODEL,
    temperature: options.temperature ?? DEFAULT_CHAT_TEMPERATURE,
    timeout: CHAT_TIMEOUT_MS,
    maxRetries: CHAT_MAX_RETRIES,
    maxConcurrency: CHAT_MAX_CONCURRENCY,
  });
}

/**
 * Build the patient Q&A EXTRACTOR: a single `withStructuredOutput` model call that pulls the
 * search parameters (patientId/name/conditionQuery/allergyQuery/…) out of the latest question,
 * using the trimmed conversation history only to resolve references ("his allergies").
 *
 * This REPLACES the old tool-calling agent. There is no agent loop and no tool execution here —
 * the model can only emit the fixed `extractionSchema` object (the core injection defense), and
 * `QaService` routes deterministically in code to the single `findPatients` retrieval.
 *
 * On a refusal / unparseable output (e.g. an injection that trips OpenAI strict mode) `parsed` is
 * null — we return an EXPLICIT {@link EMPTY_EXTRACTION} and flag `refused`, so routing reaches the
 * safe fallback intentionally instead of throwing a downstream TypeError. `includeRaw: true` keeps
 * the raw AIMessage for token-usage logging.
 */
export function createPatientQaExtractor(options: ChatModelOptions = {}): PatientQaExtractor {
  const structured = createChatModel(options).withStructuredOutput(extractionSchema, {
    name: 'extract_search_params',
    includeRaw: true,
  });

  return {
    async extract(question: string, history: ChatTurn[] = []): Promise<ExtractionResult> {
      const messages: BaseMessage[] = [
        new SystemMessage(EXTRACTION_SYSTEM_PROMPT),
        ...sanitizeAndTrim(history).map((turn) =>
          turn.role === 'user'
            ? new HumanMessage(turn.content)
            : new AIMessage(turn.content),
        ),
        new HumanMessage(question),
      ];
      const { raw, parsed } = await structured.invoke(messages);
      if (parsed == null) {
        return { extraction: EMPTY_EXTRACTION, usage: readUsage(raw), refused: true };
      }
      return { extraction: parsed, usage: readUsage(raw) };
    },
  };
}
