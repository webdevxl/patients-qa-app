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
import {
  createChatModel,
  sanitizeAndTrim,
  readUsage,
  rawContentToString,
  buildRunConfig,
  DEFAULT_CHAT_MODEL,
  type ChatModelOptions,
  type ChatTurn,
  type TokenUsage,
  type TraceContext,
} from './agent-base';

/**
 * The FIND-PATIENT agent — the FIRST model step. Given a clinician's message about the cohort
 * ("which patients have diabetes?", "Erna Shearer", a UUID…) it extracts the search parameters that
 * the `findPatients` retrieval then uses to return a LIST of candidate patients. Its job ends there:
 * the UI picks one and sends that patient's id to the `answer-patient` agent.
 *
 * The model only ever EXTRACTS the fixed `extractionSchema` object — it never decides which
 * retrieval to run and never answers the question. Routing is deterministic code in `QaService`
 * (identity wins). Constraining the model to this fixed object (vs. free tool-calling / free text)
 * is the core prompt-injection defense: the only thing it can emit is this fixed set of fields.
 */

// ───────────────────────────────── constants ─────────────────────────────────

/** Nest DI token for the find-patient agent, so `QaService` receives a mockable, config-driven instance. */
export const FIND_PATIENT_AGENT = Symbol('FIND_PATIENT_AGENT');

/** The all-null extraction: nothing identified, nothing to search → routes to the safe fallback. */
export const EMPTY_EXTRACTION: Extraction = {
  patientId: null,
  name: null,
  conditionQuery: null,
  allergyQuery: null,
  observationFilter: null,
  medicationFilter: null,
};

// ─────────────────────────────────── prompts ─────────────────────────────────

/**
 * The extraction SYSTEM prompt — a single trusted prompt targeting `extractionSchema`.
 */
const EXTRACTION_SYSTEM_PROMPT = `You extract structured search parameters from a clinician's chat message. You do NOT answer the question — another layer retrieves the records. Read the latest user message (use earlier turns only to resolve references) and fill ONLY the fields that apply:

- patientId: a patient UUID, if the message contains one. Never invent one.
- name: a person's name when the message is about ONE specific patient (full, first, or last). Resolve pronouns/references ("he/she/they", "that patient", "their meds") to the patient established in earlier turns and put that name here. Identity takes priority: if the message names a specific patient AND mentions a condition/allergy ("Is John Smith allergic to penicillin?"), set name and leave the condition/allergy fields empty.
- conditionQuery: a disease, diagnosis, or symptom to search ACROSS patients ("which patients have diabetes?"). The clinical concept only. Leave empty for a specific named patient.
- allergyQuery: a substance from an "allergic to X" search ACROSS patients ("who is allergic to penicillin?"). The substance only. An allergy is NOT a diagnosis — route "allergic to ..." here, never to conditionQuery. Set BOTH conditionQuery and allergyQuery when the message combines them ("diabetics allergic to penicillin").
- observationFilter: a numeric comparison over a vital sign / measurement ACROSS patients ("weight over 200 lbs", "heart rate above 100", "oxygen saturation below 90"). metric is one of PainLevel, Weight, Height, BloodPressure, BloodSugar, HeartRate, Temperature, RespiratoryRate, OxygenSaturation; operator is gt/gte/lt/lte/eq/between (value2 only for between); value is the raw number in the metric's NATIVE unit (Lbs, Inches, °F, mg/dL, bpm, mmHg, %, Breaths/min, pain 0–10) — never convert units. For BloodPressure set component to systolic or diastolic (default systolic). Set observationFilter ALONGSIDE conditionQuery/allergyQuery when the message combines them ("diabetics with heart rate over 100"). Leave null when no measurement comparison is asked.
- medicationFilter: which patients TAKE a drug ("who is on Tylenol?", "patients on 325 mg acetaminophen tablets", "injectable insulin"), optionally narrowed by dose/form/route. names = the drug PLUS its brand/generic synonyms for the SAME drug ("Tylenol" → ["Tylenol","acetaminophen"]); NEVER a therapeutic class (for "painkillers"/"antibiotics" leave medicationFilter null). doseText = the dose as a label prints it (number + space + uppercase unit, e.g. "325 MG"; convert "325 milligrams" → "325 MG"), else null. form = EXACTLY one of Tablet, Capsule, Solution, Suspension, Suppository, Cream, Ointment, Gel, Lotion, Spray, Inhaler ("pill" → Tablet), else null. route = EXACTLY one of Oral, Injection, Ophthalmic, Topical, Rectal, Inhalation, Transdermal, Nasal ("by mouth" → Oral, "shot"/"IV" → Injection, "eye" → Ophthalmic), else null. Set medicationFilter ALONGSIDE conditionQuery/allergyQuery/observationFilter when combined ("diabetics on metformin"). Leave null when no specific medication is named.

If the message identifies no specific patient and asks for no searchable condition, allergy, measurement, or medication, leave every field empty.`;

/**
 * The USER prompt is the raw clinician question — passed through verbatim as the latest
 * `HumanMessage` (no wrapping), with sanitized prior turns prepended so references resolve. Assembled
 * in {@link createFindPatientAgent}'s `extract()` below.
 */

// ──────────────────────────────────── schema ─────────────────────────────────

/**
 * The unified extraction schema. Its fields are exactly the UNION of the find_patients tool's
 * lookups ({patientId, name} for identity; {conditionQuery, allergyQuery, …} for attribute), so the
 * extracted object passes straight into `findPatients` with zero reshaping.
 *
 * Fields are `.nullable()` (NOT `.optional()`): @langchain/openai v1's `withStructuredOutput` uses
 * OpenAI's strict structured-outputs mode, where every key must be present — optionality is
 * expressed as `null`. The model sets the fields that apply and returns `null` for the rest; routing
 * in QaService treats null/empty identically.
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

/** What the find-patient agent returns: the parsed search params plus best-effort token usage. */
export interface ExtractionResult {
  extraction: Extraction;
  usage?: TokenUsage;
  /** True when the model refused / returned unparseable output and we substituted EMPTY_EXTRACTION. */
  refused?: boolean;
  /** Best-effort raw model output (structured tool-call args / text) — recorded in the audit log. */
  raw?: string;
}

export interface FindPatientAgent {
  /** The resolved chat model name (env override or default) — surfaced so the service can report it. */
  readonly model: string;
  extract(
    question: string,
    history?: ChatTurn[],
    trace?: TraceContext,
  ): Promise<ExtractionResult>;
}

/**
 * Build the FIND-PATIENT agent: a single `withStructuredOutput` model call that pulls the search
 * parameters (patientId/name/conditionQuery/allergyQuery/…) out of the latest question, using the
 * trimmed conversation history only to resolve references ("his allergies").
 *
 * There is no agent loop and no tool execution here — the model can only emit the fixed
 * `extractionSchema` object (the core injection defense), and `QaService` routes deterministically
 * in code to the single `findPatients` retrieval.
 *
 * On a refusal / unparseable output (e.g. an injection that trips OpenAI strict mode) `parsed` is
 * null — we return an EXPLICIT {@link EMPTY_EXTRACTION} and flag `refused`, so routing reaches the
 * safe fallback intentionally instead of throwing a downstream TypeError. `includeRaw: true` keeps
 * the raw AIMessage for token-usage logging.
 */
export function createFindPatientAgent(options: ChatModelOptions = {}): FindPatientAgent {
  const model = options.model ?? DEFAULT_CHAT_MODEL;
  const structured = createChatModel(options).withStructuredOutput(extractionSchema, {
    name: 'extract_search_params',
    includeRaw: true,
  });

  return {
    model,
    async extract(
      question: string,
      history: ChatTurn[] = [],
      trace?: TraceContext,
    ): Promise<ExtractionResult> {
      const messages: BaseMessage[] = [
        new SystemMessage(EXTRACTION_SYSTEM_PROMPT),
        ...sanitizeAndTrim(history).map((turn) =>
          turn.role === 'user'
            ? new HumanMessage(turn.content)
            : new AIMessage(turn.content),
        ),
        new HumanMessage(question),
      ];
      // The run config names + tags this call (agent:find-patient, cohort, variant) for LangSmith.
      const { raw, parsed } = await structured.invoke(
        messages,
        buildRunConfig('find-patient', trace),
      );
      const rawText = rawContentToString(raw);
      if (parsed == null) {
        return { extraction: EMPTY_EXTRACTION, usage: readUsage(raw), refused: true, raw: rawText };
      }
      return { extraction: parsed, usage: readUsage(raw), raw: rawText };
    },
  };
}
