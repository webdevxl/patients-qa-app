import type { QaResult } from './qa.service';

/**
 * Server-Sent-Events payloads for the streaming chat endpoint (`POST /qa/stream`).
 *
 * The ANSWER path (a `patientId` is selected) streams the grounded answer prose token-by-token as
 * `token` events whose `text` is the answer-SO-FAR (cumulative, so the client just assigns it), then
 * emits exactly ONE terminal event: `result` (the authoritative {@link QaResult}, byte-identical to
 * what `/qa/query` returns) on success, or `error` on an unexpected failure. The FIND path emits NO
 * `token` events — it just returns its `result`. The client renders `token` text live and finalizes
 * on `result` (citations, confidence, usage), so an imperfect mid-stream render never affects the
 * recorded answer.
 */
export type QaStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'result'; result: QaResult }
  | { type: 'error'; message: string };

/**
 * The sink the service calls with the cumulative answer-so-far as tokens arrive. The streaming
 * controller forwards each call as a `token` SSE event; the non-streaming `/qa/query` path passes no
 * sink (so its behavior — and token cost — stays exactly as before).
 */
export type TokenSink = (cumulativeAnswer: string) => void;
