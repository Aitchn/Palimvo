import { Hono, type Context } from "hono";
import { AppError as CoreError } from "@palimvo/core";
import { z } from "zod";
import { accessOf } from "../auth/access.ts";
import { principalOf } from "../auth/principal.ts";
import type { AssistantConfig } from "../assistant/config.ts";
import { ProviderKindSchema } from "../assistant/config.ts";
import { ModelOverride } from "../assistant/providers/index.ts";
import { EFFORT_LEVELS } from "../assistant/providers/types.ts";
import type { AuthService } from "../auth/service.ts";
import { readJson } from "./util.ts";

const effort = z.enum(EFFORT_LEVELS as [string, ...string[]]);

const createBody = z.object({
  kind: ProviderKindSchema,
  name: z.string().max(200),
  baseUrl: z.string().max(2000).optional(),
  apiKey: z.string().max(4000).optional(),
});
const patchBody = z.object({
  name: z.string().max(200).optional(),
  baseUrl: z.string().max(2000).nullable().optional(),
  apiKey: z.string().max(4000).optional(),
  clearKey: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const enabledBody = z.object({ enabled: z.array(z.string().max(300)).max(2000) });
const overrideBody = z.object({ model: z.string().min(1).max(300), override: ModelOverride });
const defaultsBody = z.object({
  providerId: z.string(),
  model: z.string().max(300),
  effort: effort.optional(),
});

/**
 * Assistant providers and keys: `/api/assistant/*`. Everything that changes configuration needs
 * `assistant.manage`; `GET /api/assistant/models` (what people may pick) needs `assistant.use`.
 * No response carries an API key, only whether one is set and its last four characters.
 */
export function assistantRoutes(auth: AuthService, config: AssistantConfig): Hono {
  const app = new Hono();

  const admin = (c: Context) => accessOf(c).requireServer("assistant.manage");

  const audit = (c: Context, action: string, targetId?: string, detail?: unknown) => {
    const p = principalOf(c);
    auth.store.audit.append({
      actorType: p.kind === "account" ? "account" : "system",
      ...(p.kind === "account" ? { actorId: p.account.id, actorLabel: p.account.username } : {}),
      action,
      targetType: "assistant_provider",
      ...(targetId ? { targetId } : {}),
      ...(detail === undefined ? {} : { detail }),
    });
  };

  app.get("/api/assistant/providers", (c) => {
    admin(c);
    return c.json({ providers: config.list(), defaults: config.defaults() ?? null });
  });

  app.post("/api/assistant/providers", async (c) => {
    admin(c);
    const body = await readJson(c, createBody);
    const created = config.create(body);
    audit(c, "assistant.provider_created", created.id, {
      kind: created.kind,
      name: created.name,
      keySet: created.hasKey,
    });
    return c.json(created, 201);
  });

  app.patch("/api/assistant/providers/:id", async (c) => {
    admin(c);
    const id = c.req.param("id");
    const body = await readJson(c, patchBody);
    const updated = config.update(id, body);
    audit(c, "assistant.provider_updated", id, {
      fields: Object.keys(body).filter((k) => k !== "apiKey"),
      keyChanged: body.apiKey !== undefined || body.clearKey === true,
    });
    return c.json(updated);
  });

  app.delete("/api/assistant/providers/:id", (c) => {
    admin(c);
    const id = c.req.param("id");
    config.delete(id);
    audit(c, "assistant.provider_deleted", id);
    return c.body(null, 204);
  });

  app.post("/api/assistant/providers/:id/test", async (c) => {
    admin(c);
    return c.json(await config.test(c.req.param("id")));
  });

  app.get("/api/assistant/providers/:id/models", (c) => {
    admin(c);
    return c.json({ models: config.models(c.req.param("id")) });
  });

  app.post("/api/assistant/providers/:id/models/refresh", async (c) => {
    admin(c);
    return c.json({ models: await config.refreshModels(c.req.param("id")) });
  });

  app.put("/api/assistant/providers/:id/models", async (c) => {
    admin(c);
    const id = c.req.param("id");
    const { enabled } = await readJson(c, enabledBody);
    const models = config.setEnabledModels(id, enabled);
    audit(c, "assistant.models_enabled", id, { count: enabled.length });
    return c.json({ models });
  });

  app.get("/api/assistant/model-overrides", (c) => {
    admin(c);
    return c.json({ overrides: config.overrides() });
  });

  // The model id goes in the body or query: ids such as `vendor/model` contain slashes.
  app.put("/api/assistant/model-overrides", async (c) => {
    admin(c);
    const { model, override } = await readJson(c, overrideBody);
    config.setOverride(model, override);
    audit(c, "assistant.model_override_set", undefined, { model });
    return c.json({ overrides: config.overrides() });
  });

  app.delete("/api/assistant/model-overrides", (c) => {
    admin(c);
    const model = c.req.query("model");
    if (!model) throw new CoreError("invalid_request", undefined, { reason: "model is required" });
    config.setOverride(model, null);
    audit(c, "assistant.model_override_cleared", undefined, { model });
    return c.body(null, 204);
  });

  app.put("/api/assistant/defaults", async (c) => {
    admin(c);
    const body = await readJson(c, defaultsBody);
    const saved = config.setDefaults({
      providerId: body.providerId,
      model: body.model,
      ...(body.effort ? { effort: body.effort as (typeof EFFORT_LEVELS)[number] } : {}),
    });
    audit(c, "assistant.defaults_set", undefined, saved);
    return c.json(saved);
  });

  /** What a person with `assistant.use` may choose from: switched-on models, no provider secrets. */
  app.get("/api/assistant/models", (c) => {
    accessOf(c).requireServer("assistant.use");
    return c.json({
      models: config.usableModels().map(({ providerKind: _k, ...m }) => m),
      defaults: config.defaults() ?? null,
    });
  });

  return app;
}
