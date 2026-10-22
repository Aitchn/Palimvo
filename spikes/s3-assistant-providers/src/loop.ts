import type { ChatProvider, Message, ProviderEvent, StreamRequest, ToolDef, Usage } from "./events.ts";

export interface LoopOptions {
  provider: ChatProvider;
  request: Omit<StreamRequest, "messages">;
  messages: Message[];
  execute: (name: string, input: unknown) => Promise<string>;
  signal: AbortSignal;
  maxTurns?: number;
  onEvent?: (e: ProviderEvent) => void;
}

export type LoopResult =
  | { status: "done" | "refused" | "max_tokens" | "aborted" | "error" | "turn_limit"; messages: Message[]; usage: Usage; executed: string[]; detail?: string };

/**
 * The safety rule this spike validates: a tool runs only when
 *  (1) its block completed (tool_end without inputError), AND
 *  (2) the whole message ended with stopReason "tool_use", AND
 *  (3) the signal is not aborted.
 * Anything else (abort, refusal mid-block, max_tokens truncation) discards the turn's tool calls.
 */
export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const messages = [...o.messages];
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const executed: string[] = [];
  const res = (status: LoopResult["status"], detail?: string): LoopResult => ({ status, messages, usage, executed, detail });
  for (let turn = 0; turn < (o.maxTurns ?? 8); turn++) {
    const done: { id: string; name: string; input: unknown; inputError?: string }[] = [];
    let end: Extract<ProviderEvent, { type: "message_end" }> | undefined;
    for await (const e of o.provider.stream({ ...o.request, messages }, o.signal)) {
      o.onEvent?.(e);
      if (e.type === "tool_end") done.push(e);
      else if (e.type === "usage") for (const k of Object.keys(usage) as (keyof Usage)[]) usage[k] += e.usage[k];
      else if (e.type === "message_end") end = e;
      else if (e.type === "error") return res(e.kind === "aborted" ? "aborted" : "error", e.message);
    }
    if (!end || o.signal.aborted) return res("aborted");
    if (end.stopReason === "refusal") return res("refused", end.refusalCategory ?? undefined);
    if (end.stopReason === "max_tokens") return res("max_tokens"); // may hold a truncated tool call: never run it
    messages.push({ role: "assistant", content: end.assistant });
    if (end.stopReason !== "tool_use") return res("done");
    const results = [];
    for (const t of done) {
      if (t.inputError) { results.push({ toolUseId: t.id, content: `invalid JSON input: ${t.inputError}`, isError: true }); continue; }
      if (o.signal.aborted) return res("aborted");
      executed.push(t.name);
      try { results.push({ toolUseId: t.id, content: await o.execute(t.name, t.input) }); }
      catch (err) { results.push({ toolUseId: t.id, content: String((err as Error).message), isError: true }); }
    }
    messages.push({ role: "tool", results });
  }
  return res("turn_limit");
}

export const TOOLS: ToolDef[] = [
  { name: "read_note", description: "Read a note by path", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "update_note", description: "Replace the text of a note", inputSchema: { type: "object", properties: { path: { type: "string" }, text: { type: "string" } }, required: ["path", "text"], additionalProperties: false } },
  { name: "search", description: "Search notes", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
];
