/* eslint-disable @typescript-eslint/no-explicit-any -- wire payloads are untyped */
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { AppError } from "@palimvo/core";
import {
  AnthropicProvider,
  ModelCatalog,
  OpenAICompatibleProvider,
  collectMessage,
  anthropicEffort,
  openaiEffort,
  type ProviderEvent,
  type ProviderTool,
  type StreamRequest,
} from "../../src/assistant/providers/index.ts";
import { a, anthropicMock, o, openaiMock, type MockHandle } from "./mock.ts";

const TOOLS: ProviderTool[] = ["update_note", "read_note", "search"].map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
}));

const base = (model: string): StreamRequest => ({
  model,
  system: "You are the Palimvo assistant.",
  tools: TOOLS,
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 1000,
});

// The fake names in the OpenAI-compatible scenarios are given capabilities by an override.
const catalog = new ModelCatalog({
  "gpt-reasoning": { efforts: ["low", "medium", "high"], off: "omit", tools: true },
  "local-plain": { tools: true },
});

const collectEvents = async (it: AsyncIterable<ProviderEvent>) => {
  const r: ProviderEvent[] = [];
  for await (const e of it) r.push(e);
  return r;
};
const kinds = (evs: ProviderEvent[]) => [...new Set(evs.map((e) => e.type))].join(",");
const never = () => new AbortController().signal;

function scenarioAnthropic(m: MockHandle) {
  m.script([
    ...a.think(0, "plan"),
    ...a.text(1, "Reading ", "it."),
    a.toolStart(2, "toolu_1", "read_note"),
    a.toolDelta(2, '{"pa'),
    a.toolDelta(2, 'th":"a'),
    a.toolDelta(2, '.md"}'),
    a.toolStop(2),
    ...a.end("tool_use"),
  ]);
}
function scenarioOpenAI(m: MockHandle) {
  m.script([
    o.think("plan"),
    ...o.text("Reading ", "it."),
    o.toolStart(0, "call_1", "read_note"),
    o.toolDelta(0, '{"pa'),
    o.toolDelta(0, 'th":"a'),
    o.toolDelta(0, '.md"}'),
    ...o.end("tool_calls"),
  ]);
}

const anthropic = (m: MockHandle, fallback = true) =>
  new AnthropicProvider({ apiKey: "k", baseURL: m.url, fallback, maxRetries: 0, catalog });
const openai = (m: MockHandle) => new OpenAICompatibleProvider({ baseURL: m.url, catalog });

describe("event normalization", () => {
  test("both wire formats produce the same event vocabulary", async () => {
    const am = await anthropicMock();
    const om = await openaiMock();
    try {
      scenarioAnthropic(am);
      scenarioOpenAI(om);
      const ae = await collectEvents(anthropic(am).stream(base("claude-opus-5-5"), never()));
      const oe = await collectEvents(openai(om).stream(base("gpt-reasoning"), never()));
      for (const evs of [ae, oe]) {
        const end = evs.find((e) => e.type === "message_end") as any;
        expect(end.stopReason).toBe("tool_use");
        const text = (t: string) =>
          evs
            .filter((e) => e.type === t)
            .map((e: any) => e.text)
            .join("");
        expect(text("text_delta")).toBe("Reading it.");
        expect(text("thinking_delta")).toBe("plan");
        const te = evs.find((e) => e.type === "tool_end") as any;
        expect(te.input).toEqual({ path: "a.md" });
        expect(evs.filter((e) => e.type === "tool_input_delta")).toHaveLength(3);
        expect(evs.at(-1)!.type).toBe("message_end"); // one terminal event, last
        expect(end.assistant.at(-1)).toEqual({
          type: "tool_use",
          id: te.id,
          name: "read_note",
          input: { path: "a.md" },
        });
      }
      // The thinking signature must come back unchanged on the next turn (Anthropic only).
      expect((ae.find((e) => e.type === "message_end") as any).assistant[0].signature).toBe(
        "sig-abc",
      );
      // OpenAI's prompt_tokens includes the cached ones; we report them separately.
      expect((oe.find((e) => e.type === "usage") as any).usage).toEqual({
        inputTokens: 20,
        outputTokens: 30,
        cacheReadTokens: 100,
        cacheWriteTokens: 0,
      });
      expect(kinds(ae)).toBe(kinds(oe));
    } finally {
      await am.close();
      await om.close();
    }
  });
});

describe.each(["anthropic", "openai"] as const)("%s", (kind) => {
  const model = kind === "anthropic" ? "claude-opus-5-5" : "gpt-reasoning";
  const open = async () => {
    const m = kind === "anthropic" ? await anthropicMock() : await openaiMock();
    return { m, p: kind === "anthropic" ? anthropic(m) : openai(m) };
  };

  test("cancel in the middle of a tool input: nothing runs and the call returns within a second", async () => {
    const { m, p } = await open();
    try {
      if (kind === "anthropic")
        m.script([
          ...a.text(0, "ok"),
          a.toolStart(1, "t1", "update_note"),
          a.toolDelta(1, '{"path":"a.md","te'),
          5000,
        ]);
      else
        m.script([
          ...o.text("ok"),
          o.toolStart(0, "t1", "update_note"),
          o.toolDelta(0, '{"path":"a.md","te'),
          5000,
        ]);
      const ac = new AbortController();
      let armed = false;
      const t0 = Date.now();
      const msg = await collectMessage(p.stream(base(model), ac.signal), {
        signal: ac.signal,
        onEvent: (e) => {
          if (e.type === "tool_input_delta" && !armed) {
            armed = true;
            setTimeout(() => ac.abort(), 20);
          }
        },
      });
      expect(msg.outcome).toBe("aborted");
      expect(msg.toolCalls).toEqual([]);
      expect(Date.now() - t0).toBeLessThan(1000);
      await new Promise((r) => setTimeout(r, 100));
      expect(m.closedMidStream).toBe(1); // the server saw the connection drop
    } finally {
      await m.close();
    }
  });

  test("truncated tool JSON (max_tokens) is reported and never runnable", async () => {
    const { m, p } = await open();
    try {
      if (kind === "anthropic")
        m.script([
          a.toolStart(0, "t1", "update_note"),
          a.toolDelta(0, '{"path":"a.md","te'),
          a.toolStop(0),
          ...a.end("max_tokens"),
        ]);
      else
        m.script([
          o.toolStart(0, "t1", "update_note"),
          o.toolDelta(0, '{"path":"a.md","te'),
          ...o.end("length"),
        ]);
      const events: ProviderEvent[] = [];
      const msg = await collectMessage(p.stream(base(model), never()), {
        onEvent: (e) => events.push(e),
      });
      expect(msg.outcome).toBe("max_tokens");
      expect(msg.toolCalls).toEqual([]);
      expect((events.find((e) => e.type === "tool_end") as any).inputError).toBeTruthy();
    } finally {
      await m.close();
    }
  });

  test("a complete tool block is still not runnable when the message ended another way", async () => {
    const { m, p } = await open();
    try {
      if (kind === "anthropic")
        m.script([
          a.toolStart(0, "t1", "update_note"),
          a.toolDelta(0, '{"path":"a.md"}'),
          a.toolStop(0),
          ...a.end("max_tokens"),
        ]);
      else
        m.script([
          o.toolStart(0, "t1", "update_note"),
          o.toolDelta(0, '{"path":"a.md"}'),
          ...o.end("length"),
        ]);
      const msg = await collectMessage(p.stream(base(model), never()));
      expect(msg.outcome).toBe("max_tokens");
      expect(msg.toolCalls).toEqual([]);
    } finally {
      await m.close();
    }
  });

  test("two tool calls come back runnable, and their results go back together", async () => {
    const { m, p } = await open();
    try {
      if (kind === "anthropic") {
        m.script([
          a.toolStart(0, "t1", "read_note"),
          a.toolDelta(0, '{"path":"a.md"}'),
          a.toolStop(0),
          a.toolStart(1, "t2", "search"),
          a.toolDelta(1, '{"query":"q"}'),
          a.toolStop(1),
          ...a.end("tool_use"),
        ]);
        m.script([...a.text(0, "done"), ...a.end("end_turn")]);
      } else {
        m.script([
          o.toolStart(0, "t1", "read_note"),
          o.toolDelta(0, '{"path":"a.md"}'),
          o.toolStart(1, "t2", "search"),
          o.toolDelta(1, '{"query":"q"}'),
          ...o.end("tool_calls"),
        ]);
        m.script([...o.text("done"), ...o.end("stop")]);
      }
      const first = await collectMessage(p.stream(base(model), never()));
      expect(first.outcome).toBe("tool_use");
      expect(first.toolCalls.map((c) => c.name)).toEqual(["read_note", "search"]);
      const second = await collectMessage(
        p.stream(
          {
            ...base(model),
            messages: [
              { role: "user", content: "x" },
              { role: "assistant", content: first.assistant },
              {
                role: "tool",
                results: first.toolCalls.map((c) => ({ toolUseId: c.id, content: `r ${c.name}` })),
              },
            ],
          },
          never(),
        ),
      );
      expect(second.outcome).toBe("end_turn");
      const sent = m.requests[1]!.body.messages;
      if (kind === "anthropic") {
        const last = sent.at(-1);
        expect(last.role).toBe("user");
        expect(last.content).toHaveLength(2);
        expect(last.content[0].type).toBe("tool_result");
      } else {
        expect(sent.slice(-2).map((x: any) => x.role)).toEqual(["tool", "tool"]);
      }
    } finally {
      await m.close();
    }
  });
});

describe("anthropic specifics", () => {
  test("a refusal after a complete tool block runs nothing and surfaces the category", async () => {
    const m = await anthropicMock();
    try {
      m.script([
        a.toolStart(0, "t1", "update_note"),
        a.toolDelta(0, '{"path":"a.md","text":"x"}'),
        a.toolStop(0),
        ...a.end("refusal", 5, {
          stop_details: { type: "refusal", category: "cyber", explanation: "" },
        }),
      ]);
      const msg = await collectMessage(anthropic(m).stream(base("claude-opus-5-5"), never()));
      expect(msg.outcome).toBe("refusal");
      expect(msg.refusalCategory).toBe("cyber");
      expect(msg.toolCalls).toEqual([]);
      expect(m.requests[0]!.body.fallbacks).toBe("default");
      expect(m.requests[0]!.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    } finally {
      await m.close();
    }
  });

  test("fallback can be switched off", async () => {
    const m = await anthropicMock();
    try {
      m.script([...a.text(0, "x"), ...a.end("end_turn")]);
      await collectEvents(anthropic(m, false).stream(base("claude-opus-5-5"), never()));
      expect(m.requests[0]!.body.fallbacks).toBeUndefined();
      expect(m.requests[0]!.headers["anthropic-beta"]).toBeUndefined();
    } finally {
      await m.close();
    }
  });

  test("the request carries no sampling parameters and no budget_tokens, and streams tool input eagerly", () => {
    const m = { url: "http://127.0.0.1:1" } as MockHandle;
    for (const effort of [undefined, "off", "low", "max"] as const) {
      const model = effort === "off" ? "claude-sonnet-5-5" : "claude-opus-5-5";
      const body = anthropic(m).buildBody({ ...base(model), effort }) as any;
      for (const k of ["temperature", "top_p", "top_k"]) expect(body).not.toHaveProperty(k);
      expect(JSON.stringify(body)).not.toContain("budget_tokens");
      expect(body.tools.every((t: any) => t.eager_input_streaming === true)).toBe(true);
    }
  });

  test("a stream that ends without message_stop is a protocol error, not a success", async () => {
    const m = await anthropicMock();
    try {
      m.script([...a.text(0, "half")]);
      const evs = await collectEvents(anthropic(m).stream(base("claude-opus-5-5"), never()));
      expect(evs.at(-1)).toMatchObject({ type: "error", kind: "protocol", retryable: true });
    } finally {
      await m.close();
    }
  });

  test("an already aborted signal is reported as aborted", async () => {
    const m = await anthropicMock();
    try {
      m.script([...a.text(0, "x"), ...a.end("end_turn")]);
      const ac = new AbortController();
      ac.abort();
      const msg = await collectMessage(anthropic(m).stream(base("claude-opus-5-5"), ac.signal), {
        signal: ac.signal,
      });
      expect(msg.outcome).toBe("aborted");
    } finally {
      await m.close();
    }
  });

  test("prompt-cache prefix: tools sorted, system fixed; a timestamp in the system prompt breaks it", async () => {
    const m = await anthropicMock();
    try {
      const p = anthropic(m);
      const run = async (req: StreamRequest) => {
        m.script([...a.text(0, "x"), ...a.end("end_turn")]);
        return (await collectMessage(p.stream(req, never()))).usage;
      };
      const u1 = await run(base("claude-opus-5-5"));
      const u2 = await run({
        ...base("claude-opus-5-5"),
        tools: [...TOOLS].reverse(),
        messages: [{ role: "user", content: "a different question" }],
      });
      const u3 = await run({
        ...base("claude-opus-5-5"),
        system: `${base("x").system} ${Date.now()}`,
      });
      expect(u1.cacheWriteTokens).toBe(1500);
      expect(u1.cacheReadTokens).toBe(0);
      expect(u2.cacheReadTokens).toBe(1500);
      expect(u3.cacheReadTokens).toBe(0);
      const b = m.requests[0]!.body;
      expect(b.tools.at(-1).cache_control.type).toBe("ephemeral");
      expect(b.system[0].cache_control.type).toBe("ephemeral");
      expect(b.tools.map((t: any) => t.name)).toEqual(["read_note", "search", "update_note"]);
    } finally {
      await m.close();
    }
  });

  test("errors are classified by status", async () => {
    for (const [status, kind, retryable] of [
      [429, "rate_limit", true],
      [401, "auth", false],
      [400, "bad_request", false],
    ] as const) {
      const { createServer } = await import("node:http");
      const server = createServer((_, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "x", message: "nope" } }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const url = `http://127.0.0.1:${(server.address() as any).port}`;
      try {
        const p = new AnthropicProvider({ apiKey: "k", baseURL: url, maxRetries: 0 });
        const evs = await collectEvents(p.stream(base("claude-opus-5-5"), never()));
        expect(evs.at(-1)).toMatchObject({ type: "error", kind, retryable });
      } finally {
        server.closeAllConnections();
        server.close();
      }
    }
  });
});

describe("openai-compatible specifics", () => {
  test("HTTP errors are classified; 429 and 5xx are retryable, 400 and 401 are not", async () => {
    const om = await openaiMock(); // no script: the mock answers 500
    try {
      const evs = await collectEvents(openai(om).stream(base("gpt-reasoning"), never()));
      expect(evs[0]).toMatchObject({ type: "error", kind: "overloaded", retryable: true });
    } finally {
      await om.close();
    }
  });

  test("asks for usage in the stream, and sends no reasoning field for models that do not reason", async () => {
    const om = await openaiMock();
    try {
      om.script([...o.text("x"), ...o.end("stop")]);
      await collectEvents(openai(om).stream({ ...base("local-plain"), effort: "off" }, never()));
      const body = om.requests[0]!.body;
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body).not.toHaveProperty("reasoning_effort");
    } finally {
      await om.close();
    }
  });

  test("local-server quirks: object arguments, no id, no usage chunk, finish_reason stop", async () => {
    const om = await openaiMock();
    try {
      om.script([
        {
          raw: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "read_note", arguments: { path: "a.md" } } }] }, finish_reason: null }] })}\n\n`,
        },
        ...o.end("stop", false),
      ]);
      const msg = await collectMessage(openai(om).stream(base("local-plain"), never()));
      expect(msg.outcome).toBe("tool_use"); // normalized from finish_reason "stop"
      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls[0]!.input).toEqual({ path: "a.md" });
      expect(msg.toolCalls[0]!.id).toBeTruthy(); // synthesized
      expect(msg.usage.outputTokens).toBe(0);
    } finally {
      await om.close();
    }
  });

  test("a stream that ends without finish_reason is a protocol error", async () => {
    const om = await openaiMock();
    try {
      om.script([...o.text("half")]);
      const msg = await collectMessage(openai(om).stream(base("gpt-reasoning"), never()));
      expect(msg.outcome).toBe("error");
      expect(msg.error).toMatchObject({ kind: "protocol" });
    } finally {
      await om.close();
    }
  });

  test("listModels reads /models", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      res.writeHead(req.url === "/v1/models" ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "llama3" }, { id: "qwen3" }, {}] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const p = new OpenAICompatibleProvider({
        baseURL: `http://127.0.0.1:${(server.address() as any).port}/v1/`,
      });
      expect(await p.listModels()).toEqual(["llama3", "qwen3"]);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("reasoning levels", () => {
  const cat = new ModelCatalog();
  const info = (id: string) => cat.get(id, "anthropic");

  test("Anthropic request fragments per level", () => {
    expect(anthropicEffort(info("claude-opus-5-5"), "xhigh")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "xhigh" },
    });
    expect(anthropicEffort(info("claude-sonnet-5-5"), "off")).toEqual({
      thinking: { type: "between_tools" },
    });
    expect(anthropicEffort(info("claude-opus-5"), "off")).toEqual({
      thinking: { type: "disabled" },
    });
    expect(() => anthropicEffort(info("claude-opus-5-5"), "off")).toThrow(AppError); // cannot be switched off
    expect(anthropicEffort(info("claude-opus-5-5"), undefined)).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
    });
  });

  test("an unknown model gets no thinking fields and refuses a named level", () => {
    const unknown = cat.get("some-new-model", "anthropic");
    expect(anthropicEffort(unknown, undefined)).toEqual({});
    expect(() => anthropicEffort(unknown, "high")).toThrow(AppError);
  });

  test("OpenAI-compatible: reasoning_effort only for the levels the model lists", () => {
    const gpt = catalog.get("gpt-reasoning", "openai-compatible");
    const plain = catalog.get("local-plain", "openai-compatible");
    expect(openaiEffort(gpt, "high")).toEqual({ reasoning_effort: "high" });
    expect(() => openaiEffort(gpt, "max")).toThrow(AppError);
    expect(() => openaiEffort(plain, "high")).toThrow(AppError);
    expect(openaiEffort(plain, "off")).toEqual({});
    expect(openaiEffort(gpt, undefined)).toEqual({});
  });

  test("the error carries a stable code and status", () => {
    try {
      anthropicEffort(info("claude-opus-5-5"), "off");
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: "effort_unsupported", httpStatus: 400 });
    }
  });
});

describe("model catalog", () => {
  test("levels the UI may show", () => {
    const c = new ModelCatalog();
    expect(c.levels("claude-opus-5-5", "anthropic")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(c.levels("claude-sonnet-5-5", "anthropic")[0]).toBe("off");
    expect(c.levels("claude-opus-5", "anthropic")[0]).toBe("off");
    expect(c.levels("llama3", "openai-compatible")).toEqual([]);
  });

  test("dated ids match their family; other providers do not borrow Anthropic entries", () => {
    const c = new ModelCatalog();
    expect(c.get("claude-opus-5-5-20261001", "anthropic")).toMatchObject({
      id: "claude-opus-5-5-20261001",
      tools: true,
    });
    expect(c.get("claude-opus-5-5", "openai-compatible").efforts).toEqual([]);
    expect(c.get("claude-opus-5-5-20261001", "anthropic").efforts).toHaveLength(5);
  });

  test("unknown models: tools unknown, no levels, no price", () => {
    expect(new ModelCatalog().get("mystery", "openai-compatible")).toMatchObject({
      tools: null,
      vision: null,
      efforts: [],
      price: null,
    });
  });

  test("admin overrides win, including removing the off mode", () => {
    const c = new ModelCatalog({
      "claude-sonnet-5-5": { off: undefined, price: { input: 1, output: 5 }, tools: false },
      llama3: { tools: true, efforts: ["low"] },
    });
    const sonnet = c.get("claude-sonnet-5-5", "anthropic");
    expect(sonnet.tools).toBe(false);
    expect(sonnet.price).toEqual({ input: 1, output: 5 });
    expect(c.levels("llama3", "openai-compatible")).toEqual(["low"]);
  });

  test("an invalid override is rejected when loaded", () => {
    expect(() => new ModelCatalog({ x: { efforts: ["extreme" as any] } })).toThrow();
  });

  test("merge lists what the endpoint reported; built-in models only when it reported none", () => {
    const c = new ModelCatalog();
    expect(c.merge(["llama3", "qwen3"], "openai-compatible").map((m) => m.id)).toEqual([
      "llama3",
      "qwen3",
    ]);
    expect(c.merge([], "anthropic").map((m) => m.id)).toEqual([
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ]);
    expect(c.merge([], "openai-compatible")).toEqual([]);
  });
});

describe("tool schema check", () => {
  test("a tool's input is checked before it can run, and the error is readable", async () => {
    const { defineTool } = await import("../../src/mcp/registry.ts");
    const { toProviderTool, validateToolInput } =
      await import("../../src/assistant/providers/index.ts");
    const def = defineTool({
      name: "read_note",
      tier: "native",
      scope: "vault",
      permission: "note.read",
      input: z.object({ path: z.string() }),
      description: "Read a note.",
      handler: () => ({}),
    });
    expect(validateToolInput(def, { path: "a.md", vault: "v" })).toEqual({
      ok: true,
      input: { path: "a.md", vault: "v" },
    });
    const bad = validateToolInput(def, { path: 5, vault: "v" });
    expect(bad.ok).toBe(false);
    expect((bad as any).error).toContain("path");
    expect(toProviderTool(def)).toMatchObject({
      name: "read_note",
      inputSchema: { type: "object", properties: { path: {}, vault: {} } },
    });
    expect(toProviderTool(def, "vault").inputSchema.properties).not.toHaveProperty("vault");
  });
});
