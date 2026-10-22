import {
  emptyUsage,
  type AssistantBlock,
  type ChatProvider,
  type ProviderErrorKind,
  type ProviderEvent,
  type StopReason,
  type StreamRequest,
  type Usage,
} from "./types.ts";

/** One piece of a scripted response. */
export type FakeBlock =
  | { text: string }
  | { thinking: string }
  | { tool: string; input: unknown; id?: string }
  /** A tool call whose JSON was cut off, as when the model runs out of tokens. */
  | { tool: string; rawInput: string; id?: string };

export type FakeTurn =
  | {
      blocks: FakeBlock[];
      /** Default: `tool_use` when there is a tool block, otherwise `end_turn`. */
      stop?: StopReason;
      refusalCategory?: string;
      usage?: Partial<Usage>;
      /** Wait this long (ms) before each event, so tests can cancel mid-stream. */
      delayMs?: number;
      /** Stop sending after this many events and wait until the signal aborts. */
      hangAfter?: number;
      model?: string;
    }
  | { error: ProviderErrorKind; message?: string; retryable?: boolean; status?: number };

/**
 * A provider that replays a script: one `FakeTurn` per `stream()` call. For tests and for
 * running the product without an API key. Records every request it receives.
 */
export class FakeProvider implements ChatProvider {
  readonly kind = "fake" as const;
  readonly requests: StreamRequest[] = [];
  private readonly turns: FakeTurn[];

  constructor(
    turns: readonly FakeTurn[] = [],
    private readonly models: readonly string[] = ["fake-model"],
  ) {
    this.turns = [...turns];
  }

  /** Adds a response to the end of the script. */
  push(...turns: FakeTurn[]): this {
    this.turns.push(...turns);
    return this;
  }

  async listModels(): Promise<string[]> {
    return [...this.models];
  }

  async *stream(req: StreamRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) {
      yield {
        type: "error",
        kind: "protocol",
        message: "fake provider has no scripted turn",
        retryable: false,
      };
      return;
    }
    if ("error" in turn) {
      yield {
        type: "error",
        kind: turn.error,
        message: turn.message ?? turn.error,
        status: turn.status,
        retryable: turn.retryable ?? (turn.error === "rate_limit" || turn.error === "overloaded"),
      };
      return;
    }
    let sent = 0;
    // Returns false when the stream must stop (aborted, or hung until aborted).
    const gate = async (): Promise<boolean> => {
      if (turn.hangAfter !== undefined && sent >= turn.hangAfter) {
        await new Promise<void>((r) =>
          signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true }),
        );
      } else if (turn.delayMs) {
        await new Promise<void>((r) => {
          const t = setTimeout(r, turn.delayMs);
          signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
        });
      }
      sent++;
      return !signal.aborted;
    };
    const aborted: ProviderEvent = {
      type: "error",
      kind: "aborted",
      message: "aborted",
      retryable: false,
    };
    const assistant: AssistantBlock[] = [];
    let n = 0;
    let hasTool = false;

    if (!(await gate())) return void (yield aborted);
    yield { type: "message_start", id: "fake_msg", model: turn.model ?? req.model };
    for (const block of turn.blocks) {
      const index = n++;
      if ("text" in block) {
        for (const part of chunks(block.text)) {
          if (!(await gate())) return void (yield aborted);
          yield { type: "text_delta", index, text: part };
        }
        assistant.push({ type: "text", text: block.text });
      } else if ("thinking" in block) {
        for (const part of chunks(block.thinking)) {
          if (!(await gate())) return void (yield aborted);
          yield { type: "thinking_delta", index, text: part };
        }
        assistant.push({ type: "thinking", text: block.thinking });
      } else {
        hasTool = true;
        const id = block.id ?? `fake_tool_${index}`;
        const json = "rawInput" in block ? block.rawInput : JSON.stringify(block.input);
        if (!(await gate())) return void (yield aborted);
        yield { type: "tool_start", index, id, name: block.tool };
        for (const part of chunks(json)) {
          if (!(await gate())) return void (yield aborted);
          yield { type: "tool_input_delta", index, json: part };
        }
        if (!(await gate())) return void (yield aborted);
        let input: unknown;
        let inputError: string | undefined;
        try {
          input = JSON.parse(json);
        } catch (e) {
          inputError = (e as Error).message;
        }
        if (inputError === undefined)
          assistant.push({ type: "tool_use", id, name: block.tool, input });
        yield { type: "tool_end", index, id, name: block.tool, input, inputError };
      }
    }
    if (!(await gate())) return void (yield aborted);
    yield { type: "usage", usage: { ...emptyUsage(), ...turn.usage } };
    const stopReason: StopReason = turn.stop ?? (hasTool ? "tool_use" : "end_turn");
    yield {
      type: "message_end",
      stopReason,
      rawStopReason: stopReason,
      refusalCategory: turn.refusalCategory,
      assistant,
    };
  }
}

/** Splits into 3 pieces so tests see real streaming. */
function chunks(s: string): string[] {
  if (s.length < 3) return s ? [s] : [];
  const a = Math.floor(s.length / 3);
  return [s.slice(0, a), s.slice(a, 2 * a), s.slice(2 * a)];
}
