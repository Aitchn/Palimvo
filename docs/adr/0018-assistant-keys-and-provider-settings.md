# 0018. Assistant keys and provider settings

- Status: accepted
- Date: 2026-10-22

## Context

The built-in assistant needs API keys for model providers. Keys must stay on the server: not in a
vault, not in git, not in a browser, not in a log. Only server administrators may set them.
Self-hosters also want to supply a key through an environment variable without touching the UI.

## Decision

- **Encryption.** Keys are stored in `palimvo.db` (table `secrets`) as AES-256-GCM. The nonce is
  random per value and the row id is bound in as additional authenticated data, so a ciphertext
  copied to another row does not decrypt. A value looks like `v1:<base64(nonce|tag|ciphertext)>`.
- **Master key.** `PALIMVO_SECRET_KEY` (32 bytes as base64 or hex) wins. Otherwise
  `<data dir>/secret.key` is read, or created with mode 0600 on first start. A key that is
  not 32 bytes stops the server with `config_invalid`. A stored value that does not decrypt
  (wrong or lost master key) fails only that provider with `secret_unreadable`; the admin screens
  still work, so the administrator can enter the key again.
- **Backups.** `palimvo.db` and `secret.key` are separate files on purpose: a database backup
  alone does not contain the master key, so it is useless to whoever finds it. The administrator
  keeps `secret.key` (or `PALIMVO_SECRET_KEY`) somewhere else. Losing it means re-entering keys,
  not losing notes.
- **Providers.** Table `assistant_providers` (kind `anthropic`, `openai-compatible` or `fake`,
  name, base URL, key reference, enabled) and `assistant_models` (which models the endpoint listed
  and which are switched on). The default model and level and the per-model capability overrides
  are server settings. Providers from `PALIMVO_ANTHROPIC_API_KEY` and `PALIMVO_OPENAI_API_KEY`
  (with optional `*_BASE_URL`) appear as read-only providers `env-anthropic` and `env-openai`;
  they are never copied into the database, but their models are enabled like any other.
- **Permissions.** Every route that changes or reads configuration needs `assistant.manage`
  (server administrators by default). `GET /api/assistant/models`, the list people choose
  from, needs `assistant.use` and carries no provider details.
- **What responses carry.** Whether a key is set and, for keys of 16 characters or more, its last
  four characters. Nothing else, in any API, audit entry or log line. Error text coming back from a
  provider is passed through `redact`, which removes the key and `Bearer` tokens.
- **Base URL (SSRF).** Only an administrator can set it, it must be plain `http(s)` without user
  info, query or fragment. Loopback and private addresses are allowed on purpose: that is how
  Ollama and LM Studio are reached. Because only a trusted administrator can set the address, no
  further network filtering is applied.
- **Handing a key to a provider.** Only `AssistantConfig.createChatProvider(id)` decrypts a key,
  inside the server process, for the agent loop (T47).
- **`fake` providers** can only be added when the server runs with
  `PALIMVO_ASSISTANT_ALLOW_FAKE=1` (or the test option). They let the UI and e2e tests run
  without a key.

## Consequences

The settings page (T50) and the agent loop (T47) can be built on `AssistantConfig` and the
`/api/assistant/*` routes. Rotating the master key is not supported yet: replace it by entering
the keys again.

## Alternatives considered

- Keeping keys in a file next to the vaults: easy to commit by accident.
- A system keychain: not available in containers.
- Hiding the key from `GET` but not encrypting it: a stolen database backup would then contain
  working keys.
