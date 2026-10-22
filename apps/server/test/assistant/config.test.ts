/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies are checked by field */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { maskOf } from "@palimvo/core";
import { FakeProvider, type ChatProvider } from "../../src/assistant/providers/index.ts";
import type { ProviderFactoryInput } from "../../src/assistant/config.ts";
import { SECRET_KEY_FILE, SecretBox } from "../../src/secrets/box.ts";
import { Client, PASSWORD, json } from "../client.ts";
import { startTestServer, type TestServer } from "../harness.ts";

const KEY = "sk-ant-api03-SECRETSECRETSECRET-abcd";
const KEY2 = "sk-ant-api03-OTHEROTHEROTHEROTH-wxyz";

describe("SecretBox", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "palimvo-secret-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("round-trips and uses a fresh nonce each time", () => {
    const box = SecretBox.fromKey(randomBytes(32));
    const a = box.encrypt("hello", "row1");
    expect(a).not.toContain("hello");
    expect(box.encrypt("hello", "row1")).not.toBe(a);
    expect(box.decrypt(a, "row1")).toBe("hello");
  });

  it("does not decrypt on another row, with another key, or when tampered", () => {
    const box = SecretBox.fromKey(randomBytes(32));
    const stored = box.encrypt("hello", "row1");
    expect(() => box.decrypt(stored, "row2")).toThrow(
      expect.objectContaining({ code: "secret_unreadable" }),
    );
    expect(() => SecretBox.fromKey(randomBytes(32)).decrypt(stored, "row1")).toThrow(
      expect.objectContaining({ code: "secret_unreadable" }),
    );
    const [v, b64] = stored.split(":");
    const raw = Buffer.from(b64!, "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => box.decrypt(`${v}:${raw.toString("base64")}`, "row1")).toThrow(
      expect.objectContaining({ code: "secret_unreadable" }),
    );
    expect(() => box.decrypt("garbage", "row1")).toThrow(
      expect.objectContaining({ code: "secret_unreadable" }),
    );
  });

  it("generates secret.key once, with mode 0600, and reuses it", async () => {
    const first = await SecretBox.load(dir, {});
    expect(first.source).toBe("generated");
    const file = path.join(dir, SECRET_KEY_FILE);
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = first.encrypt("x", "id");
    const again = await SecretBox.load(dir, {});
    expect(again.source).toBe("file");
    expect(again.decrypt(stored, "id")).toBe("x");
  });

  it("prefers PALIMVO_SECRET_KEY (base64 or hex) and writes no file", async () => {
    const key = randomBytes(32);
    for (const text of [key.toString("base64"), key.toString("hex")]) {
      const box = await SecretBox.load(dir, { PALIMVO_SECRET_KEY: text });
      expect(box.source).toBe("env");
      expect(SecretBox.fromKey(key).decrypt(box.encrypt("x", "i"), "i")).toBe("x");
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a malformed environment key", async () => {
    await expect(SecretBox.load(dir, { PALIMVO_SECRET_KEY: "too-short" })).rejects.toMatchObject({
      code: "config_invalid",
    });
  });
});

let server: TestServer;
let seen: ProviderFactoryInput[];
let remoteModels: string[];
let remoteFailure: string | undefined;

function factory(input: ProviderFactoryInput): ChatProvider {
  seen.push(input);
  return {
    kind: "fake",
    listModels: async () => {
      if (remoteFailure) throw new Error(remoteFailure.replace("{key}", input.apiKey ?? ""));
      return remoteModels;
    },
    stream: new FakeProvider().stream.bind(new FakeProvider()),
  };
}

beforeEach(async () => {
  seen = [];
  remoteModels = ["claude-sonnet-5-5-20261001", "claude-opus-5-5", "mystery-model"];
  remoteFailure = undefined;
  server = await startTestServer({}, { assistant: { env: {}, factory, allowFake: true } });
});
afterEach(() => server.dispose());

async function signIn(name: string, serverAdmin = false) {
  const account = await server.auth.createAccount({
    username: name,
    password: PASSWORD,
    serverAdmin,
  });
  const client = new Client(server);
  expect((await client.login(name)).status).toBe(200);
  return { client, id: account.id };
}

const create = async (client: Client, body: Record<string, unknown>) =>
  json<Record<string, any>>(await client.post("/api/assistant/providers", body));

describe("provider administration", () => {
  it("is for administrators only", async () => {
    const root = await signIn("root", true);
    const dana = await signIn("dana");
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    for (const [method, url] of [
      ["GET", "/api/assistant/providers"],
      ["POST", "/api/assistant/providers"],
      ["PATCH", `/api/assistant/providers/${p.id}`],
      ["DELETE", `/api/assistant/providers/${p.id}`],
      ["POST", `/api/assistant/providers/${p.id}/test`],
      ["POST", `/api/assistant/providers/${p.id}/models/refresh`],
      ["PUT", `/api/assistant/providers/${p.id}/models`],
      ["PUT", "/api/assistant/defaults"],
      ["PUT", "/api/assistant/model-overrides"],
    ] as const) {
      const res = await dana.client.request(url, {
        method,
        ...(method === "GET" ? {} : { json: { kind: "anthropic", name: "x", enabled: [] } }),
      });
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect(server.store.assistant.list()).toHaveLength(1);
  });

  it("needs a signed-in account", async () => {
    await signIn("root", true);
    expect((await server.fetch("/api/assistant/providers")).status).toBe(401);
  });

  it("stores the key encrypted and answers with the last four characters only", async () => {
    const root = await signIn("root", true);
    const created = await create(root.client, {
      kind: "anthropic",
      name: "Main",
      apiKey: ` ${KEY} `,
    });
    expect(created).toMatchObject({
      kind: "anthropic",
      name: "Main",
      hasKey: true,
      keyLast4: "abcd",
      source: "stored",
    });
    expect(JSON.stringify(created)).not.toContain("SECRET");

    const listed = await root.client.get("/api/assistant/providers");
    const text = await listed.text();
    expect(text).not.toContain("SECRETSECRET");
    expect(text).not.toContain(KEY);

    const row = server.store.secrets.get(server.store.assistant.list()[0]!.secretId!)!;
    expect(row.ciphertext).not.toContain("SECRET");
    expect(row.last4).toBe("abcd");

    // The provider object for the agent loop does get the plain key, and only that.
    server.services.assistant.createChatProvider(created.id);
    expect(seen.at(-1)?.apiKey).toBe(KEY);
  });

  it("keeps the key out of the database file, the logs and the audit log", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    await root.client.patch(`/api/assistant/providers/${p.id}`, { apiKey: KEY2 });
    await root.client.post(`/api/assistant/providers/${p.id}/test`);
    server.store.checkpoint();
    for (const f of await readdir(server.dataDir)) {
      if (!f.startsWith("palimvo.db")) continue;
      const bytes = (await readFile(path.join(server.dataDir, f))).toString("latin1");
      expect(bytes, f).not.toContain("SECRETSECRET");
      expect(bytes, f).not.toContain("OTHEROTHER");
    }
    expect(JSON.stringify(server.logs)).not.toContain("SECRETSECRET");
    expect(JSON.stringify(server.logs)).not.toContain("OTHEROTHER");
    const audit = JSON.stringify(server.store.audit.query({ limit: 100 }));
    expect(audit).toContain("assistant.provider_created");
    expect(audit).not.toContain("SECRETSECRET");
    expect(audit).not.toContain("OTHEROTHER");
  });

  it("replaces and clears keys; an Anthropic provider cannot lose its key", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    const replaced = await json<Record<string, any>>(
      await root.client.patch(`/api/assistant/providers/${p.id}`, { apiKey: KEY2 }),
    );
    expect(replaced.keyLast4).toBe("wxyz");
    server.services.assistant.createChatProvider(p.id);
    expect(seen.at(-1)?.apiKey).toBe(KEY2);
    expect(
      (await root.client.patch(`/api/assistant/providers/${p.id}`, { clearKey: true })).status,
    ).toBe(400);

    const local = await create(root.client, {
      kind: "openai-compatible",
      name: "Ollama",
      baseUrl: "http://localhost:11434/v1/",
      apiKey: "ollama-key-0123456789",
    });
    expect(local.baseUrl).toBe("http://localhost:11434/v1");
    const cleared = await json<Record<string, any>>(
      await root.client.patch(`/api/assistant/providers/${local.id}`, { clearKey: true }),
    );
    expect(cleared.hasKey).toBe(false);
    expect(
      server.store.secrets.get(server.store.assistant.get(local.id)!.secretId ?? "x"),
    ).toBeUndefined();
  });

  it("validates names, kinds and base URLs", async () => {
    const root = await signIn("root", true);
    const bad = async (body: Record<string, unknown>) =>
      await root.client.post("/api/assistant/providers", body);
    expect((await bad({ kind: "anthropic", name: "  ", apiKey: KEY })).status).toBe(400);
    expect((await bad({ kind: "anthropic", name: "A" })).status).toBe(400); // key required
    expect((await bad({ kind: "openai-compatible", name: "A" })).status).toBe(400); // URL required
    for (const baseUrl of [
      "ftp://x/v1",
      "file:///etc/passwd",
      "http://user:pw@host/v1",
      "http://h/v1?x=1",
      "nope",
    ]) {
      const res = await bad({ kind: "openai-compatible", name: "A", baseUrl });
      expect(res.status, baseUrl).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_provider_url");
    }
    await create(root.client, { kind: "anthropic", name: "Same", apiKey: KEY });
    expect((await bad({ kind: "anthropic", name: "same", apiKey: KEY2 })).status).toBe(409);
  });

  it("only allows fake providers when the server was started to allow them", async () => {
    const strict = await startTestServer({}, { assistant: { env: {}, factory } });
    try {
      const account = await strict.auth.createAccount({
        username: "root",
        password: PASSWORD,
        serverAdmin: true,
      });
      expect(account.id).toBeTruthy();
      const c = new Client(strict);
      await c.login("root");
      expect((await c.post("/api/assistant/providers", { kind: "fake", name: "F" })).status).toBe(
        400,
      );
    } finally {
      await strict.dispose();
    }
    const root = await signIn("root", true);
    expect((await create(root.client, { kind: "fake", name: "F" })).kind).toBe("fake");
  });

  it("deletes the provider with its key and models, and drops matching defaults", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`);
    await root.client.put(`/api/assistant/providers/${p.id}/models`, {
      enabled: ["claude-opus-5-5"],
    });
    expect(
      (
        await root.client.put("/api/assistant/defaults", {
          providerId: p.id,
          model: "claude-opus-5-5",
        })
      ).status,
    ).toBe(200);
    const secretId = server.store.assistant.get(p.id)!.secretId!;
    expect((await root.client.del(`/api/assistant/providers/${p.id}`)).status).toBe(204);
    expect(server.store.secrets.get(secretId)).toBeUndefined();
    expect(server.store.assistant.listModels(p.id)).toEqual([]);
    const after = await json<{ providers: unknown[]; defaults: unknown }>(
      await root.client.get("/api/assistant/providers"),
    );
    expect(after).toEqual({ providers: [], defaults: null });
    expect((await root.client.del(`/api/assistant/providers/${p.id}`)).status).toBe(404);
  });
});

describe("test connection and models", () => {
  it("reports success and failure without leaking the key", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    expect(await json(await root.client.post(`/api/assistant/providers/${p.id}/test`))).toEqual({
      ok: true,
      models: 3,
    });
    remoteFailure = `401 invalid key {key} (Bearer ${KEY})`;
    const failed = await json<{ ok: boolean; error: string }>(
      await root.client.post(`/api/assistant/providers/${p.id}/test`),
    );
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("401");
    expect(failed.error).not.toContain("SECRETSECRET");
  });

  it("refreshes the list, enables models, and shows capabilities and reasoning levels", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    const refreshed = await json<{
      models: Record<string, any>[];
    }>(await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`));
    expect(refreshed.models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5-20261001",
      "mystery-model",
    ]);
    expect(refreshed.models.every((m) => !m.enabled)).toBe(true);
    const byId = Object.fromEntries(refreshed.models.map((m) => [m.id, m]));
    expect(byId["claude-opus-5-5"].levels).toEqual(["low", "medium", "high", "xhigh", "max"]); // cannot be switched off
    expect(byId["claude-sonnet-5-5-20261001"].levels[0]).toBe("off");
    expect(byId["mystery-model"]).toMatchObject({ levels: [], tools: null });

    const enabled = await json<{ models: { id: string; enabled: boolean }[] }>(
      await root.client.put(`/api/assistant/providers/${p.id}/models`, {
        enabled: ["claude-sonnet-5-5-20261001", "typed-by-hand"],
      }),
    );
    expect(enabled.models.filter((m) => m.enabled).map((m) => m.id)).toEqual([
      "claude-sonnet-5-5-20261001",
      "typed-by-hand",
    ]);

    // A refresh that no longer lists an enabled model keeps it; disabled unlisted ones go.
    remoteModels = ["claude-opus-5-5"];
    const again = await json<{ models: { id: string }[] }>(
      await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`),
    );
    expect(again.models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5-20261001",
      "typed-by-hand",
    ]);
  });

  it("answers a failed refresh with a redacted error and keeps the old list", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`);
    remoteFailure = "boom {key}";
    const res = await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("SECRETSECRET");
    expect(server.store.assistant.listModels(p.id)).toHaveLength(3);
  });

  it("applies admin overrides to capabilities", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`);
    expect(
      (
        await root.client.put("/api/assistant/model-overrides", {
          model: "mystery-model",
          override: {
            tools: true,
            price: { input: 1, output: 5 },
            efforts: ["low", "high"],
            off: "omit",
          },
        })
      ).status,
    ).toBe(200);
    const models = await json<{ models: Record<string, any>[] }>(
      await root.client.get(`/api/assistant/providers/${p.id}/models`),
    );
    expect(models.models.find((m) => m.id === "mystery-model")).toMatchObject({
      tools: true,
      levels: ["off", "low", "high"],
      price: { input: 1, output: 5 },
    });
    expect(
      (
        await root.client.put("/api/assistant/model-overrides", {
          model: "x",
          override: { efforts: ["ultra"] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await root.client.del("/api/assistant/model-overrides?model=mystery-model")).status,
    ).toBe(204);
  });
});

describe("defaults and the list people choose from", () => {
  it("accepts only enabled models and levels the model supports", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`);
    const put = (body: Record<string, unknown>) => root.client.put("/api/assistant/defaults", body);
    expect((await put({ providerId: p.id, model: "claude-opus-5-5" })).status).toBe(400); // not enabled
    await root.client.put(`/api/assistant/providers/${p.id}/models`, {
      enabled: ["claude-opus-5-5", "mystery-model"],
    });
    expect((await put({ providerId: p.id, model: "claude-opus-5-5", effort: "off" })).status).toBe(
      400,
    ); // Opus 5.5 cannot be off
    expect((await put({ providerId: p.id, model: "mystery-model", effort: "high" })).status).toBe(
      400,
    );
    expect((await put({ providerId: "nope", model: "x" })).status).toBe(404);
    const ok = await json(
      await put({ providerId: p.id, model: "claude-opus-5-5", effort: "xhigh" }),
    );
    expect(ok).toEqual({ providerId: p.id, model: "claude-opus-5-5", effort: "xhigh" });
    // Switching the default model off removes the default.
    await root.client.put(`/api/assistant/providers/${p.id}/models`, {
      enabled: ["mystery-model"],
    });
    expect(server.services.assistant.defaults()).toBeUndefined();
  });

  it("refuses a disabled provider as default and drops the default when it is disabled", async () => {
    const root = await signIn("root", true);
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    await root.client.put(`/api/assistant/providers/${p.id}/models`, {
      enabled: ["claude-opus-5-5"],
    });
    const body = { providerId: p.id, model: "claude-opus-5-5" };
    expect((await root.client.put("/api/assistant/defaults", body)).status).toBe(200);
    await root.client.patch(`/api/assistant/providers/${p.id}`, { enabled: false });
    expect(server.services.assistant.defaults()).toBeUndefined();
    expect((await root.client.put("/api/assistant/defaults", body)).status).toBe(400);
  });

  it("shows people with assistant.use the enabled models, without provider details", async () => {
    const root = await signIn("root", true);
    const dana = await signIn("dana");
    const p = await create(root.client, { kind: "anthropic", name: "Main", apiKey: KEY });
    const off = await create(root.client, { kind: "fake", name: "Off", enabled: false });
    await root.client.patch(`/api/assistant/providers/${off.id}`, { enabled: false });
    await root.client.post(`/api/assistant/providers/${p.id}/models/refresh`);
    await root.client.put(`/api/assistant/providers/${p.id}/models`, {
      enabled: ["claude-sonnet-5-5-20261001"],
    });
    await root.client.put(`/api/assistant/providers/${off.id}/models`, { enabled: ["hidden"] });

    expect((await dana.client.get("/api/assistant/models")).status).toBe(403);
    const role = server.store.roles.create({
      name: "AI user",
      position: 1,
      permissions: maskOf(["assistant.use"]),
    });
    server.store.grantRole(role.id, dana.id);
    const res = await dana.client.get("/api/assistant/models");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("baseUrl");
    const body = JSON.parse(text) as { models: Record<string, unknown>[] };
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      providerName: "Main",
      id: "claude-sonnet-5-5-20261001",
    });
    // Dana still cannot read the provider list.
    expect((await dana.client.get("/api/assistant/providers")).status).toBe(403);
  });
});

describe("keys from the environment", () => {
  it("appear as read-only providers and never as stored secrets", async () => {
    const env = {
      PALIMVO_ANTHROPIC_API_KEY: "sk-ant-ENVKEYENVKEYENVKEY-1234",
      PALIMVO_OPENAI_API_KEY: "sk-openai-ENVKEYENVKEY-5678",
      PALIMVO_OPENAI_BASE_URL: "https://openrouter.ai/api/v1/",
    };
    const envServer = await startTestServer({}, { assistant: { env, factory } });
    try {
      await envServer.auth.createAccount({
        username: "root",
        password: PASSWORD,
        serverAdmin: true,
      });
      const c = new Client(envServer);
      await c.login("root");
      const res = await c.get("/api/assistant/providers");
      const text = await res.text();
      expect(text).not.toContain("ENVKEY");
      const { providers } = JSON.parse(text) as { providers: Record<string, unknown>[] };
      expect(providers).toMatchObject([
        { id: "env-anthropic", kind: "anthropic", source: "env", keyLast4: "1234", hasKey: true },
        {
          id: "env-openai",
          kind: "openai-compatible",
          source: "env",
          baseUrl: "https://openrouter.ai/api/v1",
          keyLast4: "5678",
        },
      ]);
      expect((await c.patch("/api/assistant/providers/env-anthropic", { name: "x" })).status).toBe(
        400,
      );
      expect((await c.del("/api/assistant/providers/env-openai")).status).toBe(400);
      // Models of an environment provider are managed like any other.
      expect(
        (
          await c.put("/api/assistant/providers/env-anthropic/models", {
            enabled: ["claude-opus-5-5"],
          })
        ).status,
      ).toBe(200);
      expect(await json(await c.post("/api/assistant/providers/env-anthropic/test"))).toEqual({
        ok: true,
        models: 3,
      });
      envServer.services.assistant.createChatProvider("env-openai");
      expect(seen.at(-1)).toMatchObject({
        apiKey: env.PALIMVO_OPENAI_API_KEY,
        baseUrl: "https://openrouter.ai/api/v1",
      });
      expect(envServer.store.secrets.get("env-anthropic")).toBeUndefined();
      expect(JSON.stringify(envServer.logs)).not.toContain("ENVKEY");
    } finally {
      await envServer.dispose();
    }
  });
});

describe("master key", () => {
  it("survives a restart and refuses to decrypt under a different key", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "palimvo-restart-"));
    try {
      let s = await startTestServer({ dataDir }, { assistant: { env: {}, factory } });
      await s.auth.createAccount({ username: "root", password: PASSWORD, serverAdmin: true });
      let c = new Client(s);
      await c.login("root");
      const p = await create(c, { kind: "anthropic", name: "Main", apiKey: KEY });
      await s.close();

      s = await startTestServer({ dataDir }, { assistant: { env: {}, factory } });
      s.services.assistant.createChatProvider(p.id);
      expect(seen.at(-1)?.apiKey).toBe(KEY);
      await s.close();

      s = await startTestServer(
        { dataDir },
        { assistant: { env: { PALIMVO_SECRET_KEY: randomBytes(32).toString("base64") }, factory } },
      );
      expect(() => s.services.assistant.createChatProvider(p.id)).toThrow(
        expect.objectContaining({ code: "secret_unreadable" }),
      );
      // The admin can still open the screen and replace the key.
      c = new Client(s);
      await c.login("root");
      expect((await c.get("/api/assistant/providers")).status).toBe(200);
      expect((await c.patch(`/api/assistant/providers/${p.id}`, { apiKey: KEY2 })).status).toBe(
        200,
      );
      s.services.assistant.createChatProvider(p.id);
      expect(seen.at(-1)?.apiKey).toBe(KEY2);
      await s.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
