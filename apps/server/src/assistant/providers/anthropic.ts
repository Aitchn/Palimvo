/* eslint-disable @typescript-eslint/no-explicit-any -- provider wire payloads are untyped */
import Anthropic from "@anthropic-ai/sdk";
import { ModelCatalog } from "./catalog.ts";
import { anthropicEffort } from "./effort.ts";
import {
  emptyUsage,
  type AssistantBlock,
  type ChatProvider,
  type Message,
  type ProviderEvent,
  type StopReason,
  type StreamRequest,
} from "./types.ts";

export interface AnthropicOptions {
  apiKey: string;
  baseURL?: string;
  /** Server-side fallback when the model refuses. On by default. */
  fallback?: boolean;
  catalog?: ModelCatalog;
  /** Retries of the SDK for 429/5xx before an error reaches the loop. */
  maxRetries?: number;
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
              : b.type === "redacted_thinking"
                ? { type: "redacted_thinking" as const, data: b.data }
                : {
                    type: "tool_use" as const,
                    id: b.id,
                    name: b.name,
                    input: b.input as Record<string, unknown>,
                  },
        ),
      });
    } else {
      // All results of one assistant message go in ONE user message, or the model learns to stop
      // calling tools in parallel.
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

interface Block {
  kind: "text" | "thinking" | "redacted" | "tool" | "other";
  text: string;
  sig?: string;
  id?: string;
  name?: string;
  json: string;
}

export class AnthropicProvider implements ChatProvider {
  readonly kind = "anthropic" as const;
  private readonly client: Anthropic;
  private readonly fallback: boolean;
  private readonly catalog: ModelCatalog;

  constructor(opts: AnthropicOptions) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      maxRetries: opts.maxRetries ?? 2,
    });
    this.fallback = opts.fallback ?? true;
    this.catalog = opts.catalog ?? new ModelCatalog();
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list({ limit: 100 }, { signal })) ids.push(m.id);
    return ids;
  }

  /** The request body. Prefix order is fixed: tools (sorted by name), system, then the conversation. */
  buildBody(req: StreamRequest): Record<string, unknown> {
    const tools = [...req.tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t, i, all) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        // Large inputs stream while they are being written, so the UI can show them.
        eager_input_streaming: true,
        // Cache breakpoint after the tool list.
        ...(i === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }));
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      stream: true,
      ...(tools.length ? { tools } : {}),
      // Cache breakpoint after the system prompt.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: toApiMessages(req.messages),
      ...anthropicEffort(this.catalog.get(req.model, "anthropic"), req.effort),
    };
    if (this.fallback) body.fallbacks = "default";
    return body;
  }

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    let body: Record<string, unknown>;
    try {
      body = this.buildBody(req);
    } catch (e) {
      yield {
        type: "error",
        kind: "bad_request",
        message: String((e as Error).message),
        retryable: false,
      };
      return;
    }
    const blocks = new Map<number, Block>();
    const assistant: AssistantBlock[] = [];
    const usage = emptyUsage();
    let rawStop = "";
    let stop: StopReason = "other";
    let category: string | null | undefined;
    try {
      const headers = this.fallback
        ? { "anthropic-beta": "server-side-fallback-2026-07-01" }
        : undefined;
      const stream = (await this.client.messages.create(body as any, {
        signal,
        headers,
      })) as unknown as AsyncIterable<any>;
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
            else if (cb.type === "redacted_thinking")
              blocks.set(ev.index, { kind: "redacted", text: cb.data ?? "", json: "" });
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
            else if (b.kind === "redacted")
              assistant.push({ type: "redacted_thinking", data: b.text });
            else if (b.kind === "tool") {
              let input: unknown;
              let inputError: string | undefined;
              try {
                input = b.json === "" ? {} : JSON.parse(b.json);
              } catch (e) {
                inputError = (e as Error).message;
              }
              // A call with broken JSON stays in the history (with empty input) so that the error
              // result the caller sends back has a call to answer; the model can then retry.
              assistant.push({
                type: "tool_use",
                id: b.id!,
                name: b.name!,
                input: inputError === undefined ? input : {},
              });
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
      // When the signal aborts mid-stream the SDK's iterator can end quietly instead of throwing.
      // That is a cancel, not a protocol error.
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
      yield classifyAnthropicError(e, signal);
    }
  }
}

export function classifyAnthropicError(e: unknown, signal: AbortSignal): ProviderEvent {
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
  if (e instanceof Anthropic.APIError) {
    const server = (e.status ?? 0) >= 500;
    return {
      type: "error",
      kind: server ? "overloaded" : "protocol",
      message: e.message,
      status: e.status,
      retryable: server,
    };
  }
  return {
    type: "error",
    kind: "network",
    message: String((e as Error)?.message ?? e),
    retryable: true,
  };
}
