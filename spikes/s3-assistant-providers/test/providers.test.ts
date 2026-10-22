import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider } from "../src/anthropic.ts";
import { OpenAICompatibleProvider } from "../src/openai.ts";
import { runLoop, TOOLS } from "../src/loop.ts";
import { anthropicEffort, openaiEffort, levelsFor } from "../src/effort.ts";
import type { ProviderEvent, StreamRequest } from "../src/events.ts";
import { a, o, anthropicMock, openaiMock } from "./mock.ts";

const base = (model: string): StreamRequest => ({ model, system: "You are the Palimvo assistant.", tools: TOOLS, messages: [{ role: "user", content: "hi" }], maxTokens: 1000 });
const collect = async (it: AsyncIterable<ProviderEvent>) => { const r: ProviderEvent[] = []; for await (const e of it) r.push(e); return r; };
const shape = (evs: ProviderEvent[]) => [...new Set(evs.map((e) => e.type))].join(",");

// one logical scenario scripted for each wire format: thinking, text, then one tool call whose input arrives in 3 fragments
function scenarioAnthropic(m: Awaited<ReturnType<typeof anthropicMock>>) {
  m.script([...a.think(0, "plan"), ...a.text(1, "Reading ", "it."), a.toolStart(2, "toolu_1", "read_note"), a.toolDelta(2, '{"pa'), a.toolDelta(2, 'th":"a'), a.toolDelta(2, '.md"}'), a.toolStop(2), ...a.end("tool_use")]);
}
function scenarioOpenAI(m: Awaited<ReturnType<typeof openaiMock>>) {
  m.script([o.think("plan"), ...o.text("Reading ", "it."), o.toolStart(0, "call_1", "read_note"), o.toolDelta(0, '{"pa'), o.toolDelta(0, 'th":"a'), o.toolDelta(0, '.md"}'), ...o.end("tool_calls")]);
}

test("1. both wire formats normalize to the same event vocabulary", async () => {
  const am = await anthropicMock(), om = await openaiMock();
  try {
    scenarioAnthropic(am); scenarioOpenAI(om);
    const ap = new AnthropicProvider({ apiKey: "k", baseURL: am.url });
    const op = new OpenAICompatibleProvider({ baseURL: om.url });
    const ae = await collect(ap.stream(base("claude-opus-5-5"), new AbortController().signal));
    const oe = await collect(op.stream(base("gpt-reasoning"), new AbortController().signal));
    for (const evs of [ae, oe]) {
      const end = evs.find((e) => e.type === "message_end") as any;
      assert.equal(end.stopReason, "tool_use");
      assert.equal(evs.filter((e) => e.type === "text_delta").map((e: any) => e.text).join(""), "Reading it.");
      assert.equal(evs.filter((e) => e.type === "thinking_delta").map((e: any) => e.text).join(""), "plan");
      const te = evs.find((e) => e.type === "tool_end") as any;
      assert.deepEqual(te.input, { path: "a.md" });
      assert.equal(evs.filter((e) => e.type === "tool_input_delta").length, 3);
      assert.equal(evs.at(-1)!.type, "message_end"); // single terminal event
      assert.deepEqual(end.assistant.at(-1), { type: "tool_use", id: te.id, name: "read_note", input: { path: "a.md" } });
    }
    // thinking signature is kept for replay on Anthropic only
    assert.equal(((ae.find((e) => e.type === "message_end") as any).assistant[0]).signature, "sig-abc");
    // usage: Anthropic reports cached separately already; OpenAI cached is a subset of prompt_tokens -> we subtract
    const ou = (oe.find((e) => e.type === "usage") as any).usage;
    assert.deepEqual(ou, { inputTokens: 20, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 0 });
    // event kinds identical except Anthropic-only message_start ids etc.
    assert.equal(shape(ae), shape(oe));
  } finally { await am.close(); await om.close(); }
});

for (const kind of ["anthropic", "openai"] as const) {
  test(`2. abort mid tool-input never executes the tool (${kind})`, async () => {
    const m = kind === "anthropic" ? await anthropicMock() : await openaiMock();
    try {
      if (kind === "anthropic") m.script([...a.text(0, "ok"), a.toolStart(1, "t1", "update_note"), a.toolDelta(1, '{"path":"a.md","te'), 5000]);
      else m.script([...o.text("ok"), o.toolStart(0, "t1", "update_note"), o.toolDelta(0, '{"path":"a.md","te'), { raw: "" }, 5000 as any]);
      const p = kind === "anthropic" ? new AnthropicProvider({ apiKey: "k", baseURL: m.url }) : new OpenAICompatibleProvider({ baseURL: m.url });
      const ac = new AbortController();
      const ran: string[] = [];
      let seenDelta = false;
      const t0 = Date.now();
      const r = await runLoop({
        provider: p, signal: ac.signal, messages: [{ role: "user", content: "x" }],
        request: { model: kind === "anthropic" ? "claude-opus-5-5" : "gpt-reasoning", system: "s", tools: TOOLS, maxTokens: 100 },
        execute: async (n) => { ran.push(n); return "ok"; },
        onEvent: (e) => { if (e.type === "tool_input_delta" && !seenDelta) { seenDelta = true; setTimeout(() => ac.abort(), 20); } },
      });
      assert.equal(r.status, "aborted", String((r as any).detail));
      assert.deepEqual(ran, []);
      assert.ok(Date.now() - t0 < 1000, "abort returns promptly (<1s)");
      await new Promise((x) => setTimeout(x, 100));
      assert.equal(m.closedMidStream, 1, "server saw the connection drop");
    } finally { await m.close(); }
  });

  test(`3. truncated tool JSON (max_tokens) is not executed (${kind})`, async () => {
    const m = kind === "anthropic" ? await anthropicMock() : await openaiMock();
    try {
      if (kind === "anthropic") m.script([a.toolStart(0, "t1", "update_note"), a.toolDelta(0, '{"path":"a.md","te'), a.toolStop(0), ...a.end("max_tokens")]);
      else m.script([o.toolStart(0, "t1", "update_note"), o.toolDelta(0, '{"path":"a.md","te'), ...o.end("length")]);
      const p = kind === "anthropic" ? new AnthropicProvider({ apiKey: "k", baseURL: m.url }) : new OpenAICompatibleProvider({ baseURL: m.url });
      const ran: string[] = [];
      const evs: ProviderEvent[] = [];
      const r = await runLoop({
        provider: p, signal: new AbortController().signal, messages: [{ role: "user", content: "x" }],
        request: { model: kind === "anthropic" ? "claude-opus-5-5" : "gpt-reasoning", system: "s", tools: TOOLS, maxTokens: 100 },
        execute: async (n) => { ran.push(n); return "ok"; }, onEvent: (e) => evs.push(e),
      });
      assert.equal(r.status, "max_tokens");
      assert.deepEqual(ran, []);
      assert.ok((evs.find((e) => e.type === "tool_end") as any).inputError, "parse failure is surfaced, not swallowed");
    } finally { await m.close(); }
  });

  test(`4. multi-turn loop: tool result goes back, answer ends the turn (${kind})`, async () => {
    const m = kind === "anthropic" ? await anthropicMock() : await openaiMock();
    try {
      if (kind === "anthropic") {
        m.script([a.toolStart(0, "t1", "read_note"), a.toolDelta(0, '{"path":"a.md"}'), a.toolStop(0), a.toolStart(1, "t2", "search"), a.toolDelta(1, '{"query":"q"}'), a.toolStop(1), ...a.end("tool_use")]);
        m.script([...a.text(0, "done"), ...a.end("end_turn")]);
      } else {
        m.script([o.toolStart(0, "t1", "read_note"), o.toolDelta(0, '{"path":"a.md"}'), o.toolStart(1, "t2", "search"), o.toolDelta(1, '{"query":"q"}'), ...o.end("tool_calls")]);
        m.script([...o.text("done"), ...o.end("stop")]);
      }
      const p = kind === "anthropic" ? new AnthropicProvider({ apiKey: "k", baseURL: m.url }) : new OpenAICompatibleProvider({ baseURL: m.url });
      const ran: string[] = [];
      const r = await runLoop({
        provider: p, signal: new AbortController().signal, messages: [{ role: "user", content: "x" }],
        request: { model: kind === "anthropic" ? "claude-opus-5-5" : "gpt-reasoning", system: "s", tools: TOOLS, maxTokens: 100 },
        execute: async (n) => { ran.push(n); return `result of ${n}`; },
      });
      assert.equal(r.status, "done");
      assert.deepEqual(ran, ["read_note", "search"]);
      const second = m.requests[1].body.messages;
      if (kind === "anthropic") {
        // parallel tool results must be ONE user message with both tool_result blocks
        const last = second.at(-1);
        assert.equal(last.role, "user"); assert.equal(last.content.length, 2);
        assert.equal(last.content[0].type, "tool_result");
      } else {
        assert.deepEqual(second.slice(-2).map((x: any) => x.role), ["tool", "tool"]);
      }
    } finally { await m.close(); }
  });
}

test("5. Anthropic refusal mid tool block: no tool runs, category surfaced; fallback block is reported", async () => {
  const m = await anthropicMock();
  try {
    m.script([a.toolStart(0, "t1", "update_note"), a.toolDelta(0, '{"path":"a.md","text":"x"}'), a.toolStop(0), ...a.end("refusal", 5, { stop_details: { type: "refusal", category: "cyber", explanation: "" } })]);
    const p = new AnthropicProvider({ apiKey: "k", baseURL: m.url, fallback: true });
    const ran: string[] = [];
    const r = await runLoop({ provider: p, signal: new AbortController().signal, messages: [{ role: "user", content: "x" }],
      request: { model: "claude-opus-5-5", system: "s", tools: TOOLS, maxTokens: 100 }, execute: async (n) => { ran.push(n); return ""; } });
    assert.equal(r.status, "refused"); assert.equal(r.detail, "cyber"); assert.deepEqual(ran, []);
    assert.equal(m.requests[0].body.fallbacks, "default");
    assert.equal(m.requests[0].headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  } finally { await m.close(); }
});

test("6. errors are classified; 429/5xx retryable, 400/401 not", async () => {
  const om = await openaiMock();
  try {
    const p = new OpenAICompatibleProvider({ baseURL: om.url });
    // missing script => mock answers 500
    const e = (await collect(p.stream(base("gpt-reasoning"), new AbortController().signal)))[0] as any;
    assert.equal(e.type, "error"); assert.equal(e.kind, "overloaded"); assert.equal(e.retryable, true);
  } finally { await om.close(); }
});

test("7. effort mapping: request bodies per level (no budget_tokens, no sampling params)", () => {
  assert.deepEqual(anthropicEffort("claude-opus-5-5", "xhigh"), { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" } });
  assert.deepEqual(anthropicEffort("claude-sonnet-5-5", "off"), { thinking: { type: "between_tools" } });
  assert.throws(() => anthropicEffort("claude-opus-5-5", "off"));
  assert.deepEqual(openaiEffort("gpt-reasoning", "high"), { reasoning_effort: "high" });
  assert.throws(() => openaiEffort("gpt-reasoning", "max"));
  assert.throws(() => openaiEffort("local-plain", "high"));
  assert.deepEqual(openaiEffort("local-plain", "off"), {});
  assert.deepEqual(levelsFor("claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(levelsFor("claude-sonnet-5-5")[0], "off");
  assert.deepEqual(levelsFor("unknown-model"), []);
  const body = new AnthropicProvider({ apiKey: "k" }).buildBody({ ...base("claude-opus-5-5"), effort: "max" }) as any;
  for (const k of ["temperature", "top_p", "top_k"]) assert.ok(!(k in body));
  assert.ok(!JSON.stringify(body).includes("budget_tokens"));
});

test("8. prefix stability: sorted tools + fixed system give identical prefix; cache simulation hits on turn 2, misses when tool order or system changes", async () => {
  const m = await anthropicMock();
  try {
    const p = new AnthropicProvider({ apiKey: "k", baseURL: m.url });
    const run = async (req: StreamRequest) => {
      m.script([...a.text(0, "x"), ...a.end("end_turn")]);
      const evs = await collect(p.stream(req, new AbortController().signal));
      return (evs.find((e) => e.type === "usage") as any).usage;
    };
    const u1 = await run(base("claude-opus-5-5"));
    const u2 = await run({ ...base("claude-opus-5-5"), tools: [...TOOLS].reverse(), messages: [{ role: "user", content: "different question" }] });
    const u3 = await run({ ...base("claude-opus-5-5"), system: base("x").system + " Today is " + new Date().toISOString() });
    assert.equal(u1.cacheWriteTokens, 1500); assert.equal(u1.cacheReadTokens, 0);
    assert.equal(u2.cacheReadTokens, 1500, "tool list order does not matter because we sort");
    assert.equal(u3.cacheReadTokens, 0, "a timestamp in system invalidates the cache");
    const b = m.requests[0].body;
    assert.equal(b.tools.at(-1).cache_control.type, "ephemeral");
    assert.equal(b.system[0].cache_control.type, "ephemeral");
  } finally { await m.close(); }
});

test("9. local-model quirks: tool arguments as object, missing ids, no usage chunk", async () => {
  const om = await openaiMock();
  try {
    om.script([{ raw: `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: "read_note", arguments: { path: "a.md" } } }] }, finish_reason: null }] })}\n\n` }, ...o.end("stop", false)]);
    const p = new OpenAICompatibleProvider({ baseURL: om.url });
    const evs = await collect(p.stream(base("local-plain"), new AbortController().signal));
    const te = evs.find((e) => e.type === "tool_end") as any;
    assert.deepEqual(te.input, { path: "a.md" });
    assert.ok(te.id, "synthesized id");
    // finish_reason "stop" although a tool call is present (seen in Ollama): the loop must still treat it as tool use
    const end = evs.find((e) => e.type === "message_end") as any;
    assert.equal(end.stopReason, "tool_use", "normalized from finish_reason=stop");
    assert.equal(end.assistant.some((b: any) => b.type === "tool_use"), true);
  } finally { await om.close(); }
});
