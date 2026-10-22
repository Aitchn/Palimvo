// Draft of the provider-neutral types for apps/server/src/assistant/providers/ (T45).
// Only erasable TypeScript syntax is used so the spike runs with plain `node`.

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number; // uncached input only
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Events a provider yields for ONE model response. Exactly one terminal event: message_end or error. */
export type ProviderEvent =
  | { type: "message_start"; id?: string; model?: string }
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; text: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "tool_input_delta"; index: number; json: string }
  // Emitted only when the block is complete. input is parsed JSON, or inputError is set.
  | { type: "tool_end"; index: number; id: string; name: string; input?: unknown; inputError?: string }
  | { type: "fallback"; fromModel?: string; toModel?: string }
  | { type: "usage"; usage: Usage }
  | { type: "message_end"; stopReason: StopReason; rawStopReason: string; refusalCategory?: string | null; assistant: AssistantBlock[] }
  | { type: "error"; kind: "aborted" | "rate_limit" | "overloaded" | "auth" | "bad_request" | "network" | "protocol"; message: string; status?: number; retryable: boolean };

export type AssistantBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string } // Anthropic: signature must be replayed
  | { type: "tool_use"; id: string; name: string; input: unknown };

export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantBlock[] }
  | { role: "tool"; results: { toolUseId: string; content: string; isError?: boolean }[] };

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type EffortLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamRequest {
  model: string;
  system: string;
  tools: ToolDef[];
  messages: Message[];
  effort?: EffortLevel;
  maxTokens: number;
}

export interface ChatProvider {
  stream(req: StreamRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}
