/* eslint-disable @typescript-eslint/no-explicit-any -- provider wire payloads are untyped */
import { ModelCatalog } from "./catalog.ts";
import { openaiEffort } from "./effort.ts";
import {
  emptyUsage,
  type AssistantBlock,
  type ChatProvider,
  type Message,
  type ProviderEvent,
  type StopReason,
  type StreamRequest,
} from "./types.ts";

export interface OpenAICompatibleOptions {
  /** For example `https://api.openai.com/v1` or `http://localhost:11434/v1` (Ollama). */
  baseURL: string;
  apiKey?: string;
  catalog?: ModelCatalog;
  /** Extra headers, for example OpenRouter's attribution headers. */
  headers?: Record<string, string>;
}

function toApiMessages(system: string, messages: Message[]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = m.content.flatMap((b) =>
        b.type === "tool_use"
          ? [
              {
                id: b.id,
                type: "function",
                function: { name: b.name, arguments: JSON.stringify(b.input) },
              },
            ]
          : [],
      );
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

/**
 * Chat Completions streaming for OpenAI, OpenRouter, Ollama, LM Studio, vLLM. It uses `fetch` and
 * its own small SSE parser: local servers have quirks that an SDK would hide or reject.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly kind = "openai-compatible" as const;
  private readonly base: string;
  private readonly catalog: ModelCatalog;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.base = opts.baseURL.replace(/\/+$/, "");
    this.catalog = opts.catalog ?? new ModelCatalog();
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
      ...this.opts.headers,
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch(`${this.base}/models`, { headers: this.headers(), signal });
    if (!res.ok) throw new Error(`GET /models answered ${res.status}`);
    const j = (await res.json()) as { data?: { id?: unknown }[] };
    return (j.data ?? []).flatMap((m) => (typeof m.id === "string" ? [m.id] : []));
  }

  buildBody(req: StreamRequest): Record<string, unknown> {
    const tools = [...req.tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    return {
      model: req.model,
      stream: true,
      // Without this the final usage chunk is never sent.
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
      ...(tools.length ? { tools } : {}),
      messages: toApiMessages(req.system, req.messages),
      ...openaiEffort(this.catalog.get(req.model, "openai-compatible"), req.effort),
    };
  }

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    let body: string;
    try {
      body = JSON.stringify(this.buildBody(req));
    } catch (e) {
      yield {
        type: "error",
        kind: "bad_request",
        message: String((e as Error).message),
        retryable: false,
      };
      return;
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}/chat/completions`, {
        method: "POST",
        signal,
        headers: this.headers(),
        body,
      });
    } catch (e) {
      yield failure(e, signal);
      return;
    }
    if (!res.ok) {
      const status = res.status;
      const message = (await res.text().catch(() => "")).slice(0, 500);
      yield {
        type: "error",
        status,
        // The key is never echoed by providers, but do not rely on it for logs.
        message: this.opts.apiKey ? message.split(this.opts.apiKey).join("***") : message,
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
    let text = "";
    let thinking = "";
    let finish: string | null = null;
    let started = false;
    const usage = emptyUsage();
    try {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
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
            // prompt_tokens includes the cached ones; we report them separately.
            usage.cacheReadTokens = j.usage.prompt_tokens_details?.cached_tokens ?? 0;
            usage.inputTokens = (j.usage.prompt_tokens ?? 0) - usage.cacheReadTokens;
            usage.outputTokens = j.usage.completion_tokens ?? 0;
          }
          const ch = j.choices?.[0];
          if (!ch) continue;
          const d = ch.delta ?? {};
          // DeepSeek and vLLM say reasoning_content, Ollama says reasoning.
          const r = d.reasoning_content ?? d.reasoning;
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
              // Some local servers send no id.
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
            // Ollama sometimes sends the whole arguments as an object instead of a JSON string.
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
      yield failure(e, signal);
      return;
    }
    if (signal.aborted) {
      yield { type: "error", kind: "aborted", message: "aborted", retryable: false };
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
    // There is no per-block end marker: a tool call is only known to be complete here.
    const assistant: AssistantBlock[] = [];
    if (thinking) assistant.push({ type: "thinking", text: thinking });
    if (text) assistant.push({ type: "text", text });
    for (const [i, c] of [...calls.entries()].sort((x, y) => x[0] - y[0])) {
      let input: unknown;
      let inputError: string | undefined;
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
    // Ollama-like servers answer "stop" even when tool calls are present.
    const hasCall = assistant.some((b) => b.type === "tool_use");
    const stopReason = hasCall && finish === "stop" ? "tool_use" : mapFinish(finish);
    yield { type: "message_end", stopReason, rawStopReason: finish, assistant };
  }
}

function failure(e: unknown, signal: AbortSignal): ProviderEvent {
  if (signal.aborted || (e as Error)?.name === "AbortError")
    return { type: "error", kind: "aborted", message: "aborted", retryable: false };
  return {
    type: "error",
    kind: "network",
    message: String((e as Error)?.message ?? e),
    retryable: true,
  };
}
