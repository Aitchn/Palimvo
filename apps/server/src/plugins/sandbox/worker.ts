// Entry point of a sandbox worker thread (bundled on its own for production).
import { parentPort, workerData } from "node:worker_threads";
import { openEngine, runTool } from "./engine.ts";
import { DEFAULT_LIMITS, SandboxError, type HostFunctions } from "./limits.ts";
import type { FromWorker, ToWorker, WorkerData } from "./protocol.ts";

const port = parentPort;
if (!port) throw new Error("sandbox worker must run in a worker thread");
const send = (m: FromWorker) => port.postMessage(m);
const { wasmCapMB } = (workerData ?? {}) as Partial<WorkerData>;

void (async () => {
  const engine = await openEngine({
    ...DEFAULT_LIMITS,
    wasmCapMB: wasmCapMB ?? DEFAULT_LIMITS.wasmCapMB,
  });
  let nextId = 1;
  const waiting = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const proxyFor = (names: readonly string[]): HostFunctions =>
    Object.fromEntries(
      names.map((name) => [
        name,
        (args: unknown) =>
          new Promise<unknown>((resolve, reject) => {
            const id = nextId++;
            waiting.set(id, { resolve, reject });
            send({ type: "host", id, name, args });
          }),
      ]),
    );

  port.on("message", (m: ToWorker) => {
    if (m.type === "hostResult") {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (!w) return;
      if (m.error !== undefined) w.reject(new Error(m.error));
      else w.resolve(m.value);
      return;
    }
    void (async () => {
      try {
        const r = await runTool(engine, m.source, m.tool, m.args, proxyFor(m.hostFns), m.limits);
        send({
          type: "done",
          ok: true,
          result: r.result,
          logs: r.logs,
          hostCalls: r.hostCalls,
          poisoned: engine.poisoned,
        });
      } catch (e) {
        const err = e instanceof SandboxError ? e : new SandboxError("engine", String(e));
        send({
          type: "done",
          ok: false,
          kind: err.kind,
          message: err.message,
          // Anything but a clean tool/load failure leaves the engine suspect: the pool drops this worker.
          poisoned: engine.poisoned || !["tool", "load", "result-too-large"].includes(err.kind),
        });
      } finally {
        waiting.clear();
      }
    })();
  });
  send({ type: "ready" });
})();
