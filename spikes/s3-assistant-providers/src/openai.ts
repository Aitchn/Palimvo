/* eslint-disable @typescript-eslint/no-explicit-any -- spike code: provider wire payloads are untyped */
import type {
  AssistantBlock,
  ChatProvider,
  Message,
  ProviderEvent,
  StopReason,
  StreamRequest,
} from "./events.ts";
import { openaiEffort } from "./effort.ts";

export interface OpenAIOptions {
  baseURL: string; // e.g. http://localhost:11434/v1
  apiKey?: string;
}

function toApiMessages(system: string, messages: Message[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      const calls = m.content
        .filter((b) => b.type === "tool_use")
        .map((b: any) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else
      for (const r of m.results)
        out.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
  }
  return out;
}

function mapFinish(f: string | null): StopReason {
  if (f === "stop") return "end_turn";
  if (f === "tool_calls" || f === "function_call") return "tool_use";
  if (f === "length") return "max_tokens";
  if (f === "content_filter") return "refusal";
  return "other";
}

export class OpenAICompatibleProvider implements ChatProvider {
  opts: OpenAIOptions;
  constructor(opts: OpenAIOptions) {
    this.opts = opts;
  }

  buildBody(req: StreamRequest): Record<string, unknown> {
    const tools = [...req.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    return {
      model: req.model,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
      ...(tools.length ? { tools } : {}),
      messages: toApiMessages(req.system, req.messages),
      ...openaiEffort(req.model, req.effort),
    };
  }

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(this.buildBody(req)),
      });
    } catch (e) {
      yield fail(e, signal);
      return;
    }
    if (!res.ok) {
      const status = res.status;
      const message = (await res.text().catch(() => "")).slice(0, 500);
      yield {
        type: "error",
        status,
        message,
        kind:
          status === 429
            ? "rate_limit"
            : status === 401 || status === 403
              ? "auth"
              : status >= 500
                ? "overloaded"
                : "bad_request",
        retryable: status === 429 || status >= 500,
      };
      return;
    }
    const calls = new Map<number, { id: string; name: string; args: string; started: boolean }>();
    let text = "",
      thinking = "",
      finish: string | null = null,
      started = false;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let j: any;
          try {
            j = JSON.parse(data);
          } catch {
            yield { type: "error", kind: "protocol", message: "bad SSE JSON", retryable: false };
            return;
          }
          if (!started) {
            started = true;
            yield { type: "message_start", id: j.id, model: j.model };
          }
          if (j.usage) {
            usage.cacheReadTokens = j.usage.prompt_tokens_details?.cached_tokens ?? 0;
            usage.inputTokens = (j.usage.prompt_tokens ?? 0) - usage.cacheReadTokens;
            usage.outputTokens = j.usage.completion_tokens ?? 0;
          }
          const ch = j.choices?.[0];
          if (!ch) continue;
          const d = ch.delta ?? {};
          const r = d.reasoning_content ?? d.reasoning; // DeepSeek/vLLM: reasoning_content, Ollama: reasoning
          if (typeof r === "string" && r) {
            thinking += r;
            yield { type: "thinking_delta", index: -1, text: r };
          }
          if (typeof d.content === "string" && d.content) {
            text += d.content;
            yield { type: "text_delta", index: 0, text: d.content };
          }
          for (const tc of d.tool_calls ?? []) {
            const i = tc.index ?? 0;
            let c = calls.get(i);
            if (!c) {
              c = {
                id: tc.id ?? `call_${i}`,
                name: tc.function?.name ?? "",
                args: "",
                started: false,
              };
              calls.set(i, c);
            }
            if (tc.id) c.id = tc.id;
            if (tc.function?.name) c.name = tc.function.name;
            if (!c.started && c.name) {
              c.started = true;
              yield { type: "tool_start", index: i, id: c.id, name: c.name };
            }
            const a = tc.function?.arguments;
            // Ollama sometimes sends the whole arguments as an object instead of a JSON string
            const frag =
              typeof a === "string" ? a : a && typeof a === "object" ? JSON.stringify(a) : "";
            if (frag) {
              c.args += frag;
              yield { type: "tool_input_delta", index: i, json: frag };
            }
          }
          if (ch.finish_reason) finish = ch.finish_reason;
        }
      }
    } catch (e) {
      yield fail(e, signal);
      return;
    }
    if (finish === null) {
      yield {
        type: "error",
        kind: "protocol",
        message: "stream ended without finish_reason",
        retryable: true,
      };
      return;
    }
    // OpenAI has no per-block end marker: tool_end is only knowable after finish_reason.
    const assistant: AssistantBlock[] = [];
    if (thinking) assistant.push({ type: "thinking", text: thinking });
    if (text) assistant.push({ type: "text", text });
    for (const [i, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown, inputError: string | undefined;
      try {
        input = c.args === "" ? {} : JSON.parse(c.args);
      } catch (e) {
        inputError = (e as Error).message;
      }
      if (inputError === undefined)
        assistant.push({ type: "tool_use", id: c.id, name: c.name, input });
      yield { type: "tool_end", index: i, id: c.id, name: c.name, input, inputError };
    }
    yield { type: "usage", usage };
    // Finding: some local servers (Ollama) report finish_reason "stop" even when tool calls are present.
    const hasCall = assistant.some((b) => b.type === "tool_use");
    const stopReason = hasCall && finish === "stop" ? "tool_use" : mapFinish(finish);
    yield { type: "message_end", stopReason, rawStopReason: finish, assistant };
  }
}

function fail(e: unknown, signal: AbortSignal): ProviderEvent {
  if (signal.aborted || (e as Error)?.name === "AbortError")
    return { type: "error", kind: "aborted", message: "aborted", retryable: false };
  return {
    type: "error",
    kind: "network",
    message: String((e as Error)?.message ?? e),
    retryable: true,
  };
}
