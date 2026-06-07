import { createMiddleware, AIMessage } from 'langchain';
import { type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { ANSWER_FALLBACK } from '../../agents/core/agent-base';
import {
  type InjectionGuardClassifier,
  type GuardVerdict,
} from './injection-guard.classifier';

/**
 * `beforeAgent` middleware for `createAgent` (v1.x) that runs the {@link InjectionGuardClassifier}
 * against the latest user message and short-circuits the agent loop on a `block` verdict — the
 * larger answer model is never invoked, and a verbatim {@link ANSWER_FALLBACK} surfaces as the
 * agent's final message (which `QaService` then maps onto the standard "refused" branch +
 * `ANSWER_FALLBACK` substitution).
 *
 * The verdict is also reported to the caller via the per-request `onGuardVerdict` callback on the
 * agent's runtime context — the way `QaService` stamps every guard decision (allow + block) onto
 * the audit-log trace without coupling the middleware to the trace type.
 *
 * Pairs with `injection-guard.classifier.ts` (which holds the actual LLM call + schema). When the
 * classifier is the no-op (env unset), `beforeAgent` calls it, gets an immediate `allow`, and the
 * agent proceeds — no measurable overhead.
 */

/** Callback the agent caller registers to receive the verdict (one per invocation). */
export type OnGuardVerdict = (verdict: GuardVerdict) => void;

/**
 * Per-invocation runtime-context schema this middleware declares. `onGuardVerdict` is optional so
 * an invocation that doesn't care (a test, a script) doesn't have to supply it. Functions aren't
 * naturally Zod-typed — `z.custom` brands the slot at the TypeScript layer while passing through
 * at runtime.
 */
export const injectionGuardContextSchema = z.object({
  onGuardVerdict: z.custom<OnGuardVerdict>().optional(),
});

/** Read the latest HUMAN message text from the agent state (ignoring system/AI/tool messages). */
function lastHumanText(messages: BaseMessage[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.getType?.() !== 'human') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      // Multi-part content (text+image, etc.) — concatenate text parts only.
      const text = content
        .map((part) =>
          typeof part === 'string'
            ? part
            : typeof (part as { text?: unknown }).text === 'string'
              ? ((part as { text: string }).text)
              : '',
        )
        .filter(Boolean)
        .join('\n');
      if (text) return text;
    }
  }
  return undefined;
}

/**
 * Build the middleware. The classifier is captured in the closure (one instance per process, wired
 * by `qa.module.ts`). The hook is async because the classifier round-trips to OpenAI; LangChain
 * v1.x's `beforeAgent` supports async hooks.
 */
export function injectionGuardMiddleware(classifier: InjectionGuardClassifier) {
  return createMiddleware({
    name: 'InjectionGuardMiddleware',
    contextSchema: injectionGuardContextSchema,
    beforeAgent: {
      canJumpTo: ['end'],
      hook: async (state, runtime) => {
        // ANSWER path: the LATEST human message is the clinician's current question (the
        // first human turn carries the records block, history follows, the latest is the question).
        // Empty / no human message → nothing to classify, continue.
        const text = lastHumanText(state.messages);
        if (!text) return;

        const verdict = await classifier.classify(text);

        // Stamp the verdict onto the caller's audit-log trace via the per-invocation callback. The
        // caller is responsible for any side effects (log line / trace mutation); the middleware
        // just hands the verdict off — it never reaches into the service's trace shape.
        runtime?.context?.onGuardVerdict?.(verdict);

        if (verdict.verdict === 'block') {
          // Short-circuit: emit a placeholder AIMessage and jump to END. `responseFormat` is not
          // satisfied (the answer model never ran), so the agent returns with `structuredResponse`
          // undefined — the answer-patient agent's invoke handler already maps that to
          // `UNANSWERABLE + refused: true`, which QaService translates into the safe-fallback
          // response the client sees. The AIMessage content itself is never shown to the user.
          return {
            messages: [new AIMessage(ANSWER_FALLBACK)],
            jumpTo: 'end' as const,
          };
        }
        return;
      },
    },
  });
}
