import {
  emptyUsage,
  type AssistantBlock,
  type ProviderErrorKind,
  type ProviderEvent,
  type StopReason,
  type Usage,
} from "./types.ts";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type MessageOutcome =
  /** The model asked for tools; `toolCalls` are safe to run. */
  | "tool_use"
  | "end_turn"
  /** Cut off: any tool block in `assistant` may be truncated and was NOT put in `toolCalls`. */
  | "max_tokens"
  | "refusal"
  | "other"
  | "aborted"
  | "error";

export interface CollectedMessage {
  outcome: MessageOutcome;
  /** Blocks to put back into the conversation history (empty unless the message ended normally). */
  assistant: AssistantBlock[];
  /** Runnable tool calls: the message is complete, ended in `tool_use`, and was not cancelled. */
  toolCalls: ToolCall[];
  /** Tool blocks whose JSON could not be parsed; answer them with an error result, never run them. */
  invalidToolCalls: { id: string; name: string; error: string }[];
  stopReason?: StopReason;
  refusalCategory?: string | null;
  usage: Usage;
  fallback?: { fromModel?: string; toModel?: string };
  error?: { kind: ProviderErrorKind; message: string; status?: number; retryable: boolean };
}

/**
 * Folds one response's events into a result. This is where the rule that keeps cancelled or cut
 * off tool calls from running lives: a tool call is runnable only when
 *  1. its block is complete and its JSON parsed,
 *  2. the whole message ended with the stop reason `tool_use`, and
 *  3. the signal has not been aborted.
 * Providers differ in when they can know (OpenAI has no block end), so the rule is applied to
 * the finished message and never to a single block.
 */
export async function collectMessage(
  events: AsyncIterable<ProviderEvent>,
  opts: { signal?: AbortSignal; onEvent?: (e: ProviderEvent) => void } = {},
): Promise<CollectedMessage> {
  const usage = emptyUsage();
  const complete: ToolCall[] = [];
  const invalid: CollectedMessage["invalidToolCalls"] = [];
  let end: Extract<ProviderEvent, { type: "message_end" }> | undefined;
  let error: Extract<ProviderEvent, { type: "error" }> | undefined;
  let fallback: CollectedMessage["fallback"];

  for await (const e of events) {
    opts.onEvent?.(e);
    switch (e.type) {
      case "tool_end":
        if (e.inputError !== undefined)
          invalid.push({ id: e.id, name: e.name, error: e.inputError });
        else complete.push({ id: e.id, name: e.name, input: e.input });
        break;
      case "usage":
        for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += e.usage[k];
        break;
      case "fallback":
        fallback = { fromModel: e.fromModel, toModel: e.toModel };
        break;
      case "message_end":
        end = e;
        break;
      case "error":
        error = e;
        break;
    }
  }

  const base = { usage, fallback, toolCalls: [], invalidToolCalls: [], assistant: [] };
  if (opts.signal?.aborted || error?.kind === "aborted")
    return { ...base, outcome: "aborted", error: error ? errorOf(error) : undefined };
  if (error) return { ...base, outcome: "error", error: errorOf(error) };
  if (!end)
    return {
      ...base,
      outcome: "error",
      error: {
        kind: "protocol",
        message: "stream ended without a terminal event",
        retryable: true,
      },
    };

  const result: CollectedMessage = {
    ...base,
    outcome: end.stopReason,
    assistant: end.assistant,
    stopReason: end.stopReason,
    refusalCategory: end.refusalCategory,
  };
  if (end.stopReason === "tool_use") {
    result.toolCalls = complete;
    result.invalidToolCalls = invalid;
  }
  return result;
}

function errorOf(
  e: Extract<ProviderEvent, { type: "error" }>,
): NonNullable<CollectedMessage["error"]> {
  return { kind: e.kind, message: e.message, status: e.status, retryable: e.retryable };
}
