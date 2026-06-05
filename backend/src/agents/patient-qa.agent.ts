import { ChatOpenAI } from '@langchain/openai';
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';

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
 * prompt-injection defense: the only thing the model can emit is these four strings.
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
});

export type Extraction = z.infer<typeof extractionSchema>;

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
 * nudge the four extracted fields — it can never replace the instructions or bypass routing.
 */
export function sanitizeAndTrim(history: ChatTurn[] | undefined): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (t): t is ChatTurn =>
        !!t &&
        (t.role === 'user' || t.role === 'assistant') &&
        typeof t.content === 'string' &&
        t.content.trim().length > 0,
    )
    .map((t) => ({ role: t.role, content: t.content.trim().slice(0, MAX_CONTENT_CHARS) }))
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

If the message identifies no specific patient and asks for no searchable condition or allergy, leave every field empty.`;

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
}

export interface PatientQaExtractor {
  extract(question: string, history?: ChatTurn[]): Promise<ExtractionResult>;
}

/** Pull token usage off the raw AIMessage (shape: `usage_metadata`), if present. */
function readUsage(raw: unknown): ExtractionUsage | undefined {
  const u = (
    raw as {
      usage_metadata?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
      };
    } | null
  )?.usage_metadata;
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    totalTokens: u.total_tokens,
  };
}

/**
 * Build the patient Q&A EXTRACTOR: a single `withStructuredOutput` model call that pulls the
 * search parameters (patientId/name/conditionQuery/allergyQuery) out of the latest question,
 * using the trimmed conversation history only to resolve references ("his allergies").
 *
 * This REPLACES the old tool-calling agent. There is no agent loop and no tool execution here —
 * the model can only emit the fixed `extractionSchema` object (the core injection defense), and
 * `QaService` routes deterministically in code to the single `findPatients` retrieval. Same single
 * LLM call as before, but the routing/tie-breaks now live in testable code rather than the prompt.
 *
 * `includeRaw: true` keeps the raw AIMessage so we can still log token usage (previously done by
 * the tracing middleware). Pure LangChain — no Nest decorators; reads OPENAI_API_KEY from env.
 */
export function createPatientQaExtractor(): PatientQaExtractor {
  const model = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });
  const structured = model.withStructuredOutput(extractionSchema, {
    name: 'extract_search_params',
    includeRaw: true,
  });

  return {
    async extract(question: string, history: ChatTurn[] = []): Promise<ExtractionResult> {
      const messages: BaseMessage[] = [
        new SystemMessage(EXTRACTION_SYSTEM_PROMPT),
        ...sanitizeAndTrim(history).map((t) =>
          t.role === 'user' ? new HumanMessage(t.content) : new AIMessage(t.content),
        ),
        new HumanMessage(question),
      ];
      const res = (await structured.invoke(messages)) as {
        raw: unknown;
        parsed: Extraction;
      };
      return { extraction: res.parsed, usage: readUsage(res.raw) };
    },
  };
}
