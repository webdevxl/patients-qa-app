import { createMiddleware } from 'langchain';
import { Logger } from '@nestjs/common';
import type { BaseMessage } from '@langchain/core/messages';

/**
 * "Tool is the last step" middleware — makes the retrieval tool terminal.
 *
 * The default agent loop sends a tool's output back to the model for a second pass:
 *
 *   beforeModel → model → afterModel → tools → beforeModel → model → … → afterAgent
 *
 * Here we deliberately DON'T want that. `find_patient` already returns the exact records the
 * client needs; re-feeding them to the LLM would only add latency, cost, and a chance for the
 * model to paraphrase or leak. So the moment the tool has run we jump straight to `end`:
 *
 *   beforeModel → model → afterModel → tools → beforeModel(✋ jumpTo 'end') → afterAgent
 *
 * Mechanism: `beforeModel` runs before EVERY model call. On the first pass the last message is
 * the human question, so we pass through and let the model pick the patient and call the tool.
 * On the next pass the last message is the tool's `ToolMessage`, which is our signal that the
 * data is ready — we return `{ jumpTo: 'end' }`, skipping the second model call entirely. The
 * tool result therefore stays the last message in state, and `QaService` returns it verbatim.
 *
 * Order this middleware BEFORE the tracing middleware so its `beforeModel` short-circuits first
 * and tracing never logs a phantom "calling model" for the call we cancel.
 */

const logger = new Logger('AgentTerminate');

/** True when `msg` is a tool result (`ToolMessage`), i.e. the tool node just produced output. */
function isToolMessage(msg: BaseMessage | undefined): boolean {
  if (!msg) return false;
  const type =
    typeof (msg as { getType?: () => string }).getType === 'function'
      ? (msg as { getType: () => string }).getType()
      : (msg as { _getType?: () => string })._getType?.();
  return type === 'tool';
}

export function createTerminateAfterToolMiddleware() {
  return createMiddleware({
    name: 'TerminateAfterToolMiddleware',
    beforeModel: {
      // Declare the jump target so the agent graph wires an edge from beforeModel → end.
      canJumpTo: ['end'],
      hook: (state) => {
        const last = state.messages[state.messages.length - 1];
        if (isToolMessage(last)) {
          logger.log(
            '🛑 tool result ready — ending agent (records returned to client, not re-sent to the model)',
          );
          return { jumpTo: 'end' as const };
        }
        return undefined;
      },
    },
  });
}
