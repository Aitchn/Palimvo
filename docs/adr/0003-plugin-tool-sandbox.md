# 0003. Plugin MCP tools run in a QuickJS sandbox on a worker pool

- Status: accepted
- Date: 2026-10-22

## Context

Plugins add MCP tools (the decisions plugin is the first). Their code runs on the server, written
by people the server owner may not know, and an AI client triggers it. ADR 0001 (D4) chose
QuickJS compiled to WebAssembly. The S2 spike (`plan/palimvo/spikes/s2-plugin-sandbox.md`)
measured it and found one thing the plan did not expect: **QuickJS's `setMemoryLimit` is not a
reliable cap** in the wasm build. With 8 MB set, a hostile loop reached 382 MB (arrays) or 2 GB
(typed arrays), and after an out-of-memory the heap could be damaged (`dispose` aborts,
`computeMemoryUsage` traps). A sandbox that trusts the engine's own limit is not a sandbox.

## Decision

Three layers, none optional:

1. **A hard ceiling on the wasm memory.** Every worker creates its own
   `WebAssembly.Memory({ maximum })` (64 MB by default) and gives it to the engine. The engine's
   own `setMemoryLimit` stays on, so ordinary overuse is a clean error, but only the ceiling
   cannot be exceeded.
2. **Plugin code never runs on the main thread.** `SandboxPool` keeps `PALIMVO_PLUGIN_WORKERS`
   (default 4) long-lived `worker_threads`, started at server start. Each holds one wasm instance
   and one QuickJS runtime. A call has a soft timeout inside the engine (interrupt handler) and a
   hard one on the main thread, 300 ms later, that calls `worker.terminate()`. A spinning plugin,
   catastrophic regex or host call that never answers cannot stall the server (measured: the main
   thread was blocked 6-20 ms).
3. **Anything unclean discards the worker.** A timeout, out-of-memory, wasm trap, abort or crash
   drops the whole worker and its wasm instance and starts a new one; it is never reused. Healthy
   workers are also replaced after 500 calls or 10 minutes, because the long-lived runtime grew a
   little over thousands of calls.

Further rules:

- **A new context per call**, on the worker's long-lived runtime. Globals and `Object.prototype`
  changes cannot reach the next call. (A long-lived context saves little: the cost is parsing the
  plugin source, 5 ms for a typical 30 KB plugin.)
- The stack limit is **256 KB**. 512 KB lets the wasm hit V8's own stack limit first and poisons the
  engine.
- The plugin sees only `vault` (`read`, `list`, `search`, `write`, `propose`) and `console.log`
  (100 lines, returned to the caller as debug output). No network, files, timers, `require`.
  Host functions take and return JSON; objects are rebuilt inside the context with `JSON.parse`,
  so a `__proto__` key stays data.
- **Permissions are checked on the server side.** A path must be covered by a folder the manifest
  declares **and** the caller must hold the permission there (`pluginMayAccess`); the plugin never
  has more than the person or token behind the call. The author of its changes is fixed by the
  host (plugin X for AI client Y). Up to 200 host calls and 1 MiB of result per call; arguments are
  checked against the manifest's JSON Schema before any plugin code runs.
- **What runs is what was approved.** `PluginManager.load` re-hashes the files on every call.
- Tools are named `<plugin-id>.<tool>`, are advanced tools (found with `list_tools`, run with
  `call_tool`), and exist only in vaults where the plugin runs. A vault can additionally list them
  in `tools/list` of `/mcp/<vault>` (`.palimvo/config.json`, key `pluginTools.listed`).
- The worker is part of the single-file bundle: `scripts/bundle.mjs` builds it on its own and embeds
  its code in `dist/palimvo.mjs`; from source the pool starts `worker.ts`.

## Consequences

- The wasm engine, `quickjs-emscripten-core` and the single-file wasm variant, are pinned exactly
  (0.32.0). QuickJS is a C engine with a history of memory-safety bugs; wasm keeps such a bug inside
  the instance's linear memory. Dependabot watches the pin, and approval of each plugin hash by a
  person stays.
- Plugins cannot use the network or timers. A plugin that needs a network would get a declarative
  host API with a host allow-list; there is none yet.
- `tools/list_changed` cannot be pushed: the MCP endpoint is stateless POST (no server-to-client
  stream). A client sees the current list each time it asks; one that caches the list must ask again
  after a plugin or the vault setting changes.
- A fire-and-forget host call (`vault.write(...)` without `await`) that the plugin started before it
  returned can still finish on the server after the call ended; plugins should await their writes.
- Errors from a plugin tool reach the AI as `internal` (the plugin threw), `unavailable` (time or
  memory), `payload_too_large` (result) or `rate_limited` (the pool's queue is full).
