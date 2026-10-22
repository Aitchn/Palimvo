/* eslint-disable @typescript-eslint/no-explicit-any -- spike code: provider wire payloads are untyped */
import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantBlock,
  ChatProvider,
  Message,
  ProviderEvent,
  StopReason,
  StreamRequest,
} from "./events.ts";
import { anthropicEffort } from "./effort.ts";

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  /** server-side fallback on refusals (plan: on by default) */
  fallback?: boolean;
}

function toApiMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content.map((b) =>
          b.type === "text"
            ? { type: "text" as const, text: b.text }
            : b.type === "thinking"
              ? { type: "thinking" as const, thinking: b.text, signature: b.signature ?? "" }
              : {
                  type: "tool_use" as const,
                  id: b.id,
                  name: b.name,
                  input: b.input as Record<string, unknown>,
                },
        ),
      });
    } else {
      // all results of one assistant turn go in ONE user message
      out.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolUseId,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }
  }
  return out;
}

function mapStop(s: string | null | undefined): StopReason {
  if (s === "end_turn" || s === "stop_sequence") return "end_turn";
  if (s === "tool_use" || s === "max_tokens" || s === "refusal") return s;
  return "other";
}

export class AnthropicProvider implements ChatProvider {
  client: Anthropic;
  opts: AnthropicOptions;
  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    this.client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL, maxRetries: 2 });
  }

  /** Request body. Stable prefix: tools sorted by name, then system, then messages. */
  buildBody(req: StreamRequest): Record<string, unknown> {
    const tools = [...req.tools]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t, i, arr) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        eager_input_streaming: true,
        ...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" } } : {}), // breakpoint after the tool list
      }));
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      tools,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }], // breakpoint after system
      messages: toApiMessages(req.messages),
      ...anthropicEffort(req.model, req.effort),
    };
    if (this.opts.fallback) body.fallbacks = "default";
    return body;
  }

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const body = this.buildBody(req);
    const blocks = new Map<
      number,
      {
        kind: "text" | "thinking" | "tool" | "other";
        text: string;
        sig?: string;
        id?: string;
        name?: string;
        json: string;
      }
    >();
    const assistant: AssistantBlock[] = [];
    let rawStop = "",
      stop: StopReason = "other",
      category: string | null | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let stream: AsyncIterable<any>;
    try {
      const headers = this.opts.fallback
        ? { "anthropic-beta": "server-side-fallback-2026-07-01" }
        : undefined;
      stream = (await this.client.messages.create(body as any, { signal, headers })) as any;
      for await (const ev of stream) {
        switch (ev.type) {
          case "message_start":
            Object.assign(usage, {
              inputTokens: ev.message.usage.input_tokens ?? 0,
              cacheReadTokens: ev.message.usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: ev.message.usage.cache_creation_input_tokens ?? 0,
            });
            yield { type: "message_start", id: ev.message.id, model: ev.message.model };
            break;
          case "content_block_start": {
            const cb = ev.content_block;
            if (cb.type === "text") blocks.set(ev.index, { kind: "text", text: "", json: "" });
            else if (cb.type === "thinking")
              blocks.set(ev.index, { kind: "thinking", text: "", json: "" });
            else if (cb.type === "tool_use") {
              blocks.set(ev.index, { kind: "tool", text: "", json: "", id: cb.id, name: cb.name });
              yield { type: "tool_start", index: ev.index, id: cb.id, name: cb.name };
            } else {
              blocks.set(ev.index, { kind: "other", text: "", json: "" });
              if (cb.type === "fallback")
                yield {
                  type: "fallback",
                  fromModel: cb.from_model ?? cb.model,
                  toModel: cb.to_model,
                };
            }
            break;
          }
          case "content_block_delta": {
            const b = blocks.get(ev.index);
            if (!b) break;
            const d = ev.delta;
            if (d.type === "text_delta") {
              b.text += d.text;
              yield { type: "text_delta", index: ev.index, text: d.text };
            } else if (d.type === "thinking_delta") {
              b.text += d.thinking;
              yield { type: "thinking_delta", index: ev.index, text: d.thinking };
            } else if (d.type === "signature_delta") b.sig = (b.sig ?? "") + d.signature;
            else if (d.type === "input_json_delta") {
              b.json += d.partial_json;
              yield { type: "tool_input_delta", index: ev.index, json: d.partial_json };
            }
            break;
          }
          case "content_block_stop": {
            const b = blocks.get(ev.index);
            if (!b) break;
            if (b.kind === "text") assistant.push({ type: "text", text: b.text });
            else if (b.kind === "thinking")
              assistant.push({ type: "thinking", text: b.text, signature: b.sig });
            else if (b.kind === "tool") {
              let input: unknown, inputError: string | undefined;
              try {
                input = b.json === "" ? {} : JSON.parse(b.json);
              } catch (e) {
                inputError = (e as Error).message;
              }
              if (inputError === undefined)
                assistant.push({ type: "tool_use", id: b.id!, name: b.name!, input });
              yield {
                type: "tool_end",
                index: ev.index,
                id: b.id!,
                name: b.name!,
                input,
                inputError,
              };
            }
            break;
          }
          case "message_delta":
            rawStop = ev.delta.stop_reason ?? rawStop;
            category = ev.delta.stop_details?.category ?? category;
            usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
            if (ev.usage?.input_tokens != null) usage.inputTokens = ev.usage.input_tokens;
            if (ev.usage?.cache_read_input_tokens != null)
              usage.cacheReadTokens = ev.usage.cache_read_input_tokens;
            if (ev.usage?.cache_creation_input_tokens != null)
              usage.cacheWriteTokens = ev.usage.cache_creation_input_tokens;
            stop = mapStop(rawStop);
            break;
          case "message_stop":
            yield { type: "usage", usage: { ...usage } };
            yield {
              type: "message_end",
              stopReason: stop,
              rawStopReason: rawStop,
              refusalCategory: category,
              assistant,
            };
            return;
          case "error":
            yield {
              type: "error",
              kind: ev.error?.type === "overloaded_error" ? "overloaded" : "protocol",
              message: ev.error?.message ?? "stream error",
              retryable: ev.error?.type === "overloaded_error",
            };
            return;
        }
      }
      // Finding: when the signal aborts mid-stream the SDK's async iterator can end quietly instead of throwing.
      if (signal.aborted) {
        yield { type: "error", kind: "aborted", message: "aborted", retryable: false };
        return;
      }
      yield {
        type: "error",
        kind: "protocol",
        message: "stream ended without message_stop",
        retryable: true,
      };
    } catch (e) {
      yield classify(e, signal);
    }
  }
}

export function classify(e: unknown, signal: AbortSignal): ProviderEvent {
  if (
    signal.aborted ||
    (e as Error)?.name === "AbortError" ||
    e instanceof Anthropic.APIUserAbortError
  )
    return { type: "error", kind: "aborted", message: "aborted", retryable: false };
  if (e instanceof Anthropic.RateLimitError)
    return { type: "error", kind: "rate_limit", message: e.message, status: 429, retryable: true };
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return { type: "error", kind: "auth", message: e.message, status: e.status, retryable: false };
  if (e instanceof Anthropic.BadRequestError)
    return {
      type: "error",
      kind: "bad_request",
      message: e.message,
      status: 400,
      retryable: false,
    };
  if (e instanceof Anthropic.APIConnectionError)
    return { type: "error", kind: "network", message: e.message, retryable: true };
  if (e instanceof Anthropic.APIError)
    return {
      type: "error",
      kind: (e.status ?? 0) >= 500 ? "overloaded" : "protocol",
      message: e.message,
      status: e.status,
      retryable: (e.status ?? 0) >= 500,
    };
  return {
    type: "error",
    kind: "network",
    message: String((e as Error)?.message ?? e),
    retryable: true,
  };
}
