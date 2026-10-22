import { describe, expect, test } from "vitest";
import {
  FakeProvider,
  collectMessage,
  type StreamRequest,
} from "../../src/assistant/providers/index.ts";

const req = (): StreamRequest => ({
  model: "fake-model",
  system: "s",
  tools: [],
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 100,
});

describe("fake provider", () => {
  test("replays a multi-step tool conversation", async () => {
    const p = new FakeProvider([
      {
        blocks: [
          { thinking: "look first" },
          { text: "Reading." },
          { tool: "read_note", input: { path: "a.md" } },
        ],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { blocks: [{ text: "Done." }] },
    ]);
    const first = await collectMessage(p.stream(req(), new AbortController().signal));
    expect(first.outcome).toBe("tool_use");
    expect(first.toolCalls).toEqual([
      { id: "fake_tool_2", name: "read_note", input: { path: "a.md" } },
    ]);
    expect(first.usage.inputTokens).toBe(10);
    expect(first.assistant.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    const second = await collectMessage(p.stream(req(), new AbortController().signal));
    expect(second.outcome).toBe("end_turn");
    expect(p.requests).toHaveLength(2);
    expect(await p.listModels()).toEqual(["fake-model"]);
  });

  test("cut-off tool JSON is invalid, refusal and max_tokens run nothing", async () => {
    const p = new FakeProvider([
      { blocks: [{ tool: "update_note", rawInput: '{"path":"a' }] },
      { blocks: [{ tool: "update_note", input: {} }], stop: "refusal", refusalCategory: "cyber" },
      { blocks: [{ tool: "update_note", input: {} }], stop: "max_tokens" },
    ]);
    const s = () => new AbortController().signal;
    const cut = await collectMessage(p.stream(req(), s()));
    expect(cut.outcome).toBe("tool_use");
    expect(cut.toolCalls).toEqual([]);
    expect(cut.invalidToolCalls).toHaveLength(1);
    const refused = await collectMessage(p.stream(req(), s()));
    expect(refused).toMatchObject({ outcome: "refusal", refusalCategory: "cyber", toolCalls: [] });
    const truncated = await collectMessage(p.stream(req(), s()));
    expect(truncated).toMatchObject({ outcome: "max_tokens", toolCalls: [] });
  });

  test("cancel while hanging: ends as aborted and the tool does not become runnable", async () => {
    const p = new FakeProvider([
      { blocks: [{ tool: "update_note", input: { path: "a.md" } }], hangAfter: 3 },
    ]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    const msg = await collectMessage(p.stream(req(), ac.signal), { signal: ac.signal });
    expect(msg.outcome).toBe("aborted");
    expect(msg.toolCalls).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("scripted errors and an empty script", async () => {
    const p = new FakeProvider([{ error: "rate_limit" }]);
    const s = new AbortController().signal;
    expect((await collectMessage(p.stream(req(), s))).error).toMatchObject({
      kind: "rate_limit",
      retryable: true,
    });
    expect((await collectMessage(p.stream(req(), s))).error).toMatchObject({ kind: "protocol" });
  });
});
