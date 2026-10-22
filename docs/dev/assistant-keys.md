# Assistant keys and provider settings

For administrators and for people building on `AssistantConfig` (`apps/server/src/assistant/config.ts`).
Design reasons are in [ADR 0018](../adr/0018-assistant-keys-and-provider-settings.md).

## Giving the server a key

Either in the web app (T50 adds the screen; until then the API below) or through the environment:

| Variable                       | Effect                                                                |
| ------------------------------ | --------------------------------------------------------------------- |
| `PALIMVO_ANTHROPIC_API_KEY`    | Adds the read-only provider "Anthropic (environment)".                |
| `PALIMVO_ANTHROPIC_BASE_URL`   | Optional, for a proxy.                                                |
| `PALIMVO_OPENAI_API_KEY`       | Adds "OpenAI (environment)" (OpenAI-compatible).                      |
| `PALIMVO_OPENAI_BASE_URL`      | Default `https://api.openai.com/v1`. Use it for OpenRouter and so on. |
| `PALIMVO_SECRET_KEY`           | Master key for stored keys: `openssl rand -base64 32`.                |
| `PALIMVO_ASSISTANT_ALLOW_FAKE` | `1` lets an administrator add `fake` providers (demos, tests).        |

## The master key

Keys added through the API are encrypted with a master key. Without `PALIMVO_SECRET_KEY` the
server creates `<data dir>/secret.key` (mode 0600) on first start.

**Keep a copy of `secret.key` apart from your database backups.** Backups of `palimvo.db` do not
contain it, so a stolen backup cannot reveal your keys; but if you lose the master key you have to
enter the keys again. Never put `secret.key` in a vault, a git repository or a Docker image.

If a stored key cannot be decrypted the server logs nothing secret and the provider answers
`secret_unreadable`; open the provider and enter the key again.

## API

All under `/api/assistant`, with `assistant.manage` unless noted. No response contains a key.

| Method and path                                          | Purpose                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /providers`                                         | Providers (`hasKey`, `keyLast4`, `source`) and the defaults.                                  |
| `POST /providers`                                        | `{kind, name, baseUrl?, apiKey?}`. Anthropic needs a key; OpenAI-compatible needs a base URL. |
| `PATCH /providers/:id`                                   | `{name?, baseUrl?, apiKey?, clearKey?, enabled?}`.                                            |
| `DELETE /providers/:id`                                  | Removes the provider, its key and its model rows.                                             |
| `POST /providers/:id/test`                               | Asks the endpoint for its models. Answers `{ok, models}` or `{ok:false, error}`.              |
| `POST /providers/:id/models/refresh`                     | Reads and remembers the model list.                                                           |
| `GET /providers/:id/models`                              | Models with capabilities, reasoning levels and prices.                                        |
| `PUT /providers/:id/models`                              | `{enabled: [modelId, …]}`: exactly these are switched on.                                     |
| `PUT /defaults`                                          | `{providerId, model, effort?}`. Model must be on, level supported.                            |
| `PUT /model-overrides`, `DELETE /model-overrides?model=` | Capability and price overrides per model id.                                                  |
| `GET /models` (`assistant.use`)                          | The switched-on models people may choose from.                                                |

`AssistantConfig.createChatProvider(providerId)` returns the `ChatProvider` for the agent loop; it
is the only place a key is decrypted.
