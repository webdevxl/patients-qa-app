import { createMiddleware } from 'langchain';
import { Logger } from '@nestjs/common';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { BaseMessage } from '@langchain/core/messages';

/**
 * Agent tracing middleware — full-lifecycle observability for the patient Q&A agent.
 *
 * It taps every hook of the LangChain 1.x agent loop (the diagram the user shared):
 *
 *   request → beforeAgent → ┌─ beforeModel → wrapModelCall(model) → afterModel ─┐ → afterAgent → result
 *                           └──────────────── wrapToolCall(tools) ←─────────────┘   (loops until no tool calls)
 *
 * What each hook gives us:
 *   • beforeAgent    — runs once; the incoming question + a fresh trace id for correlation.
 *   • beforeModel    — runs every iteration; marks the start of model-call N.
 *   • wrapModelCall  — wraps the LLM call: logs the EXACT request we send the model
 *                      (system prompt, tools, full message history) and the raw response
 *                      (content, tool calls, token usage, latency). This is also the seam
 *                      where you customize what the LLM receives (see "CUSTOMIZE" below).
 *   • wrapToolCall   — wraps each tool invocation: tool name, args, result, latency.
 *   • afterModel     — runs every iteration; what the model decided (final answer vs. tool calls).
 *   • afterAgent     — runs once; total iterations, total latency, final answer.
 *
 * The middleware is pure LangChain (no Nest decorators), matching the rest of the agent
 * layer. It only *reads* and logs — it never alters the agent's behavior — so it is safe to
 * leave enabled. Logging goes through a Nest `Logger` so it lines up with the rest of the
 * backend's console output.
 */

const logger = new Logger('AgentTrace');

/** Per-middleware-instance options. */
export interface TracingOptions {
  /** Max characters for any single logged value (messages, args, results) before truncation. */
  maxValueLength?: number;
}

/**
 * Per-invocation state. A plain Zod object — with no checkpointer wired up, the agent gets a
 * fresh copy of this for every `.invoke()`, so the counters reset per request.
 *   • traceId    — short correlation id, stamped once in beforeAgent, echoed on every line.
 *   • modelCalls — incremented in beforeModel; doubles as the loop-iteration counter.
 *   • startedAt  — epoch ms at agent start, for end-to-end latency in afterAgent.
 */
const tracingState = z.object({
  traceId: z.string().default(''),
  modelCalls: z.number().default(0),
  startedAt: z.number().default(0),
});

// ───────────────────────── formatting helpers ─────────────────────────

const DEFAULT_MAX = 800;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… (+${s.length - max} chars)`;
}

/** Flatten a message's `content` (string | content-block array) to plain text. */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'string'
          ? part
          : typeof (part as { text?: unknown })?.text === 'string'
            ? (part as { text: string }).text
            : '',
      )
      .join('');
  }
  return '';
}

/** Best-effort compact JSON for arbitrary values (tool args, results). */
function preview(value: unknown, max: number): string {
  let s: string;
  try {
    s = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  return truncate(s ?? String(value), max);
}

/** One-line summary of a single message in the conversation, prefixed with its index. */
function describeMessage(msg: BaseMessage, idx: number, max: number): string {
  const type =
    typeof (msg as { getType?: () => string }).getType === 'function'
      ? (msg as { getType: () => string }).getType()
      : (msg as { _getType?: () => string })._getType?.() ?? 'unknown';

  const toolCalls = (msg as { tool_calls?: Array<{ name: string; args: unknown }> })
    .tool_calls;

  if (type === 'ai' && toolCalls?.length) {
    const calls = toolCalls
      .map((c) => `${c.name}(${preview(c.args, max)})`)
      .join(', ');
    const text = contentToText(msg.content).trim();
    return `#${idx} [ai] ${text ? `"${truncate(text, max)}" + ` : ''}🔧 ${calls}`;
  }

  if (type === 'tool') {
    const name = (msg as { name?: string }).name ?? 'tool';
    return `#${idx} [tool:${name}] → ${truncate(contentToText(msg.content), max)}`;
  }

  return `#${idx} [${type}] ${truncate(contentToText(msg.content), max)}`;
}

/** Multi-line, indented dump of the whole message list sent to the model. */
function describeMessages(messages: BaseMessage[], max: number): string {
  if (!messages.length) return '  (no messages)';
  return messages.map((m, i) => `  ${describeMessage(m, i, max)}`).join('\n');
}

// ───────────────────────── the middleware ─────────────────────────

export function createTracingMiddleware(options: TracingOptions = {}) {
  const max = options.maxValueLength ?? DEFAULT_MAX;

  return createMiddleware({
    name: 'TracingMiddleware',
    stateSchema: tracingState,

    /** Once, at the very start of the run. */
    beforeAgent: (state) => {
      const traceId = randomUUID().slice(0, 8);
      const startedAt = Date.now();
      const question = contentToText(
        state.messages[state.messages.length - 1]?.content,
      );

      logger.log(
        `🏁 [${traceId}] agent start — ${state.messages.length} message(s)\n` +
          `   ❓ question: "${truncate(question, max)}"`,
      );

      return { traceId, startedAt, modelCalls: 0 };
    },

    /** Before each model call — marks the start of loop iteration N. */
    beforeModel: (state) => {
      const iteration = state.modelCalls + 1;
      logger.log(
        `🔄 [${state.traceId}] iteration #${iteration} — calling model ` +
          `(history: ${state.messages.length} message(s))`,
      );
      return { modelCalls: iteration };
    },

    /**
     * Wraps the actual LLM call. We log the full outgoing request and the raw response.
     *
     * ┌─ CUSTOMIZE WHAT GOES TO THE LLM ──────────────────────────────────────────────┐
     * │ `request` is everything about to be sent to the model — mutate a COPY here to   │
     * │ change what the LLM sees, then pass it to `handler(...)`. Examples:             │
     * │                                                                                │
     * │   const patched = {                                                            │
     * │     ...request,                                                                │
     * │     systemPrompt: request.systemPrompt + '\nExtra guardrail instructions…',    │
     * │     messages: request.messages.filter(keepRelevant),  // trim / window history │
     * │     tools: request.tools,                             // add / drop tools      │
     * │     model: someOtherModel,                            // swap model            │
     * │   };                                                                           │
     * │   return handler(patched);                                                     │
     * │                                                                                │
     * │ Default below is pass-through (unchanged), so tracing alone has no side effects.│
     * └────────────────────────────────────────────────────────────────────────────────┘
     */
    wrapModelCall: async (request, handler) => {
      const { traceId, modelCalls } = request.state;
      const toolNames = request.tools.map((t) => t.name).join(', ') || '(none)';
      const systemPrompt =
        request.systemPrompt ?? contentToText(request.systemMessage?.content);

      logger.log(
        `📤 [${traceId}] → model (iteration #${modelCalls})\n` +
          `   🤖 model: ${(request.model as { model?: string })?.model ?? 'unknown'}\n` +
          `   🧰 tools: ${toolNames}\n` +
          `   📜 systemPrompt: "${truncate(systemPrompt ?? '', max)}"\n` +
          `   💬 messages (${request.messages.length}):\n` +
          describeMessages(request.messages, max),
      );

      // --- the actual model invocation (pass-through; see CUSTOMIZE box above) ---
      const startedAt = Date.now();
      const response = await handler(request);
      const elapsedMs = Date.now() - startedAt;

      const aiText = contentToText(
        (response as { content?: unknown }).content,
      ).trim();
      const toolCalls =
        (response as { tool_calls?: Array<{ name: string; args: unknown }> })
          .tool_calls ?? [];
      const usage = (
        response as {
          usage_metadata?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
          };
        }
      ).usage_metadata;

      const decision = toolCalls.length
        ? `🔧 ${toolCalls.length} tool call(s): ` +
          toolCalls.map((c) => `${c.name}(${preview(c.args, max)})`).join(', ')
        : `✅ final answer: "${truncate(aiText, max)}"`;
      const tokens = usage
        ? ` | tokens in/out/total: ${usage.input_tokens ?? '?'}/${usage.output_tokens ?? '?'}/${usage.total_tokens ?? '?'}`
        : '';

      logger.log(
        `📥 [${traceId}] ← model (iteration #${modelCalls}) in ${elapsedMs}ms${tokens}\n` +
          `   ${decision}`,
      );

      return response;
    },

    /**
     * Wraps each tool execution. We log the call (name + args), then the result + latency.
     * (This is also where you could short-circuit / authorize / cache a tool — left as
     * pass-through here.)
     */
    wrapToolCall: async (request, handler) => {
      const traceId = (request.state as { traceId?: string }).traceId ?? '????';
      const { name, args } = request.toolCall;

      logger.log(
        `🔧 [${traceId}] tool call → ${name}(${preview(args, max)})`,
      );

      const startedAt = Date.now();
      const result = await handler(request);
      const elapsedMs = Date.now() - startedAt;

      logger.log(
        `🔧 [${traceId}] tool done ← ${name} in ${elapsedMs}ms → ` +
          truncate(contentToText((result as { content?: unknown }).content), max),
      );

      return result;
    },

    /** After each model call — what the model decided this iteration. */
    afterModel: (state) => {
      const last = state.messages[state.messages.length - 1];
      const toolCalls =
        (last as { tool_calls?: Array<{ name: string }> })?.tool_calls ?? [];
      const verdict = toolCalls.length
        ? `↩️ will run ${toolCalls.length} tool(s): ${toolCalls.map((c) => c.name).join(', ')}`
        : `🎯 produced final answer — loop will end`;
      logger.log(`🧠 [${state.traceId}] iteration #${state.modelCalls} ${verdict}`);
      return undefined;
    },

    /** Once, after the loop ends. */
    afterAgent: (state) => {
      const totalMs = state.startedAt ? Date.now() - state.startedAt : 0;
      const answer = contentToText(
        state.messages[state.messages.length - 1]?.content,
      );
      logger.log(
        `🏁 [${state.traceId}] agent done — ${state.modelCalls} model call(s), ` +
          `${state.messages.length} message(s), ${totalMs}ms\n` +
          `   💡 answer: "${truncate(answer, max)}"`,
      );
      return undefined;
    },
  });
}
