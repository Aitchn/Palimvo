// Provider-neutral types of the assistant (T45). Every provider turns its wire format into
// `ProviderEvent`s, so the agent loop (T47) and the UI never see provider-specific shapes.

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  /** Uncached input only. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export type ProviderErrorKind =
  "aborted" | "rate_limit" | "overloaded" | "auth" | "bad_request" | "network" | "protocol";

export type AssistantBlock =
  | { type: "text"; text: string }
  /** Anthropic: `signature` must be sent back unchanged on the next turn. */
  | { type: "thinking"; text: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

/**
 * Events for ONE model response. Exactly one terminal event comes last: `message_end` or `error`.
 */
export type ProviderEvent =
  | { type: "message_start"; id?: string; model?: string }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  /** For showing what is being written. Never execute anything based on it. */
  | { type: "tool_input_delta"; index: number; json: string }
  /** Only sent for a complete block: `input` is parsed JSON, or `inputError` says why it is not. */
  | {
      type: "tool_end";
      index: number;
      id: string;
      name: string;
      input?: unknown;
      inputError?: string;
    }
  | { type: "fallback"; fromModel?: string; toModel?: string }
  | { type: "usage"; usage: Usage }
  | {
      type: "message_end";
      stopReason: StopReason;
      rawStopReason: string;
      refusalCategory?: string | null;
      assistant: AssistantBlock[];
    }
  | {
      type: "error";
      kind: ProviderErrorKind;
      message: string;
      status?: number;
      retryable: boolean;
    };

export type TerminalEvent = Extract<ProviderEvent, { type: "message_end" | "error" }>;

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantBlock[] }
  /** All results of one assistant message belong in ONE message. */
  | { role: "tool"; results: { toolUseId: string; content: string; isError?: boolean }[] };

/** A tool as the model sees it. */
export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What the user picks in the UI. `off` is only offered for models that can switch thinking off. */
export type EffortLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "off",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface StreamRequest {
  model: string;
  /**
   * Must stay identical between turns: no times, user names or open files (they go in the last
   * message), or the prompt cache never hits.
   */
  system: string;
  tools: ProviderTool[];
  messages: Message[];
  effort?: EffortLevel;
  maxTokens: number;
}

export type ProviderKind = "anthropic" | "openai-compatible" | "fake";

export interface ChatProvider {
  readonly kind: ProviderKind;
  /** Model ids the endpoint says it serves. */
  listModels(signal?: AbortSignal): Promise<string[]>;
  /** Never throws: failures arrive as the terminal `error` event. */
  stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
