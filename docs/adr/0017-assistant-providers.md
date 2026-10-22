# 0017. Assistant model providers

- Status: accepted
- Date: 2026-10-22

## Context

The built-in assistant (M12) talks to Anthropic and to OpenAI-compatible endpoints (OpenAI,
OpenRouter, Ollama, LM Studio, vLLM). The agent loop (T47) and the web panel must not know which
one is behind a conversation. Spike S3 built a prototype against hand-written mock streams (no API
key was available) and found five details that would otherwise cause wrong behaviour.

## Decision

`apps/server/src/assistant/providers/` holds the provider layer.

- **One event vocabulary.** Every provider turns its stream into `ProviderEvent`s. A call ends
  with exactly one terminal event, `message_end` or `error`, and never throws.
- **Tools run only on a finished message.** `collectMessage` folds the events and lists a tool
  call as runnable only when its block is complete and parsed, the whole message ended with the
  stop reason `tool_use`, and the signal was not aborted. OpenAI-style streams have no block end,
  so the rule is applied to the message, not to the block, for both providers. A refusal or a
  `max_tokens` cut-off can leave a complete-looking tool block; it is never run. Tools do not
  start while the model is still writing (no overlap optimisation in 0.1.0).
- **Cancel is checked after the stream ends.** The Anthropic SDK's iterator can finish quietly
  when aborted; the provider checks `signal.aborted` and reports `aborted`, not a protocol error.
- **Anthropic requests** send no `temperature`, `top_p`, `top_k` or `budget_tokens` (rejected
  since 2026-10-21). Thinking is `adaptive` with `display: "summarized"` and `output_config.effort`.
  "Off" depends on the model: `between_tools` for Sonnet 5.5, `disabled` for Opus 5, not offered
  for Opus 5.5. Tools are sorted by name and carry `eager_input_streaming`; cache breakpoints sit
  after the tool list and after the system prompt; server-side fallback is on by default.
- **OpenAI-compatible requests** use `fetch` and a small SSE parser rather than an SDK, because
  local servers send arguments as objects, omit ids and usage, or report `stop` for tool calls;
  these are normalised. `stream_options.include_usage` is always set, and `prompt_tokens` is
  split into uncached and cached so usage means the same for both providers.
- **Model catalog.** `models.json` lists known models and their capabilities. An id with a date
  suffix matches its family. Unknown models offer no reasoning levels and have unknown tool
  support. Prices and context sizes are left empty until an admin sets them rather than guessed.
  The endpoint's own `/models` list and admin overrides are merged on top (the admin screen is
  T46 and T50).
- A `FakeProvider` replays scripted turns for tests and for running without a key.
- `toProviderTool` and `validateToolInput` let the assistant use the MCP registry's tool
  definitions, and check what the model wrote against the schema before anything runs.

## Consequences

The loop and UI can be built and tested against `FakeProvider`. What the mocks cannot show is
still open: real prompt-cache hits, the real shape of refusal and fallback blocks, tool-call
reliability of small local models, and latency. If real behaviour differs, fix it before T47.

## Alternatives considered

- The OpenAI SDK for OpenAI-compatible endpoints: another dependency that rejects the local
  servers' quirks.
- Executing a tool as soon as its block ends on Anthropic: saves time but cannot be done on
  OpenAI-style streams and gives two behaviours to test.
