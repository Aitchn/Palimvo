/* eslint-disable @typescript-eslint/no-explicit-any -- spike code: provider wire payloads are untyped */
// Mock servers speaking the documented wire formats of the Anthropic Messages stream and
// OpenAI Chat Completions stream. The fixtures are hand-written from the public docs, NOT
// recorded from real services; live.ts re-runs the same scenarios against real endpoints.
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export type Step = number | { ev: string; data: unknown } | { raw: string } | "hang";

export interface MockHandle {
  url: string;
  requests: { body: any; headers: Record<string, any> }[];
  closedMidStream: number;
  script(steps: Step[]): void;
  close(): Promise<void>;
}

async function start(
  handler: (body: any, h: MockHandle, headers: any) => Step[],
): Promise<MockHandle> {
  const h: MockHandle = {
    url: "",
    requests: [],
    closedMidStream: 0,
    script: () => {},
    close: async () => {},
  };
  const queue: Step[][] = [];
  h.script = (s) => void queue.push(s);
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const body = JSON.parse(raw || "{}");
      h.requests.push({ body, headers: req.headers });
      const steps = queue.shift();
      if (!steps) {
        res.writeHead(500).end("no script");
        return;
      }
      const override = handler(body, h, req.headers);
      let closed = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          closed = true;
          h.closedMidStream++;
        }
      });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const s of [...override, ...steps]) {
        if (closed) return;
        if (s === "hang") {
          await new Promise((r) => res.on("close", r));
          return;
        }
        if (typeof s === "number") await new Promise((r) => setTimeout(r, s));
        else if ("raw" in s) res.write(s.raw);
        else res.write(`event: ${s.ev}\ndata: ${JSON.stringify(s.data)}\n\n`);
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  h.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return h;
}

// ---------- Anthropic ----------
const seenPrefixes = new Set<string>();
export async function anthropicMock() {
  seenPrefixes.clear();
  return start((body) => {
    // cache simulation: identical (tools, system) prefix seen before => cache read
    const key = createHash("sha256")
      .update(JSON.stringify([body.tools, body.system]))
      .digest("hex");
    const hit = seenPrefixes.has(key);
    seenPrefixes.add(key);
    return [
      {
        ev: "message_start",
        data: {
          type: "message_start",
          message: {
            id: "msg_1",
            model: body.model,
            role: "assistant",
            content: [],
            usage: {
              input_tokens: 40,
              output_tokens: 1,
              cache_read_input_tokens: hit ? 1500 : 0,
              cache_creation_input_tokens: hit ? 0 : 1500,
            },
          },
        },
      },
    ];
  });
}
const A = (ev: string, data: any): Step => ({ ev, data: { type: ev, ...data } });
export const a = {
  think: (i: number, text: string): Step[] => [
    A("content_block_start", { index: i, content_block: { type: "thinking", thinking: "" } }),
    A("content_block_delta", { index: i, delta: { type: "thinking_delta", thinking: text } }),
    A("content_block_delta", {
      index: i,
      delta: { type: "signature_delta", signature: "sig-abc" },
    }),
    A("content_block_stop", { index: i }),
  ],
  text: (i: number, ...parts: string[]): Step[] => [
    A("content_block_start", { index: i, content_block: { type: "text", text: "" } }),
    ...parts.map((t) =>
      A("content_block_delta", { index: i, delta: { type: "text_delta", text: t } }),
    ),
    A("content_block_stop", { index: i }),
  ],
  toolStart: (i: number, id: string, name: string): Step =>
    A("content_block_start", {
      index: i,
      content_block: { type: "tool_use", id, name, input: {} },
    }),
  toolDelta: (i: number, json: string): Step =>
    A("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: json } }),
  toolStop: (i: number): Step => A("content_block_stop", { index: i }),
  end: (stop: string, out = 30, extra: any = {}): Step[] => [
    A("message_delta", { delta: { stop_reason: stop, ...extra }, usage: { output_tokens: out } }),
    A("message_stop", {}),
  ],
};

// ---------- OpenAI-compatible ----------
export async function openaiMock() {
  return start(() => []);
}
const O = (delta: any, finish: string | null = null): Step => ({
  raw: `data: ${JSON.stringify({ id: "c1", model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
});
export const o = {
  text: (...parts: string[]): Step[] => parts.map((t) => O({ content: t })),
  think: (t: string): Step => O({ reasoning_content: t }),
  toolStart: (i: number, id: string, name: string): Step =>
    O({ tool_calls: [{ index: i, id, type: "function", function: { name, arguments: "" } }] }),
  toolDelta: (i: number, args: string | object): Step =>
    O({ tool_calls: [{ index: i, function: { arguments: args } }] }),
  end: (finish: string, usage = true): Step[] => [
    O({}, finish),
    ...(usage
      ? [
          {
            raw: `data: ${JSON.stringify({ id: "c1", choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 100 } } })}\n\n`,
          },
        ]
      : []),
    { raw: "data: [DONE]\n\n" },
  ],
};
