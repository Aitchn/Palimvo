import { randomUUID } from "node:crypto";
import { AppError as CoreError } from "@palimvo/core";
import { isUniqueViolation, type Db, type Row } from "./db.ts";

export type ProviderKind = "anthropic" | "openai-compatible" | "fake";

export interface StoredSecret {
  id: string;
  /** Output of `SecretBox.encrypt`. Never leaves the server. */
  ciphertext: string;
  /** Last four characters of the plain value, for telling keys apart in the UI. */
  last4: string;
}

/** Encrypted values such as API keys. The plain text is never stored. */
export class SecretsRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  newId(): string {
    return randomUUID();
  }

  /** Inserts or replaces; `ciphertext` must have been encrypted with this `id` bound in. */
  put(id: string, ciphertext: string, last4: string): void {
    const at = this.now();
    this.db.run(
      `insert into secrets (id, ciphertext, last4, created_at, updated_at) values (?, ?, ?, ?, ?)
       on conflict (id) do update set ciphertext = excluded.ciphertext, last4 = excluded.last4,
         updated_at = excluded.updated_at`,
      id,
      ciphertext,
      last4,
      at,
      at,
    );
  }

  get(id: string): StoredSecret | undefined {
    const r = this.db.get("select id, ciphertext, last4 from secrets where id = ?", id);
    return r
      ? { id: r.id as string, ciphertext: r.ciphertext as string, last4: r.last4 as string }
      : undefined;
  }

  delete(id: string): void {
    this.db.run("delete from secrets where id = ?", id);
  }
}

export interface AssistantProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  secretId?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface NewAssistantProvider {
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  secretId?: string;
  enabled?: boolean;
}

export interface AssistantProviderPatch {
  name?: string;
  /** `null` clears it. */
  baseUrl?: string | null;
  secretId?: string | null;
  enabled?: boolean;
}

export interface ProviderModelRow {
  providerId: string;
  modelId: string;
  enabled: boolean;
}

const toProvider = (r: Row): AssistantProvider => ({
  id: r.id as string,
  kind: r.kind as ProviderKind,
  name: r.name as string,
  ...(typeof r.base_url === "string" ? { baseUrl: r.base_url } : {}),
  ...(typeof r.secret_id === "string" ? { secretId: r.secret_id } : {}),
  enabled: r.enabled === 1,
  createdAt: r.created_at as number,
  updatedAt: r.updated_at as number,
});

/** Model providers the administrator configured, and which of their models are switched on. */
export class AssistantRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  create(input: NewAssistantProvider): AssistantProvider {
    const id = randomUUID();
    const at = this.now();
    try {
      this.db.run(
        `insert into assistant_providers (id, kind, name, base_url, secret_id, enabled, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.kind,
        input.name,
        input.baseUrl ?? null,
        input.secretId ?? null,
        input.enabled === false ? 0 : 1,
        at,
        at,
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new CoreError("already_exists", undefined, { name: input.name });
      throw err;
    }
    return this.require(id);
  }

  get(id: string): AssistantProvider | undefined {
    const r = this.db.get("select * from assistant_providers where id = ?", id);
    return r ? toProvider(r) : undefined;
  }

  require(id: string): AssistantProvider {
    const p = this.get(id);
    if (!p) throw new CoreError("not_found", undefined, { provider: id });
    return p;
  }

  list(): AssistantProvider[] {
    return this.db
      .all("select * from assistant_providers order by name collate nocase")
      .map(toProvider);
  }

  update(id: string, patch: AssistantProviderPatch): AssistantProvider {
    const current = this.require(id);
    const next = {
      name: patch.name ?? current.name,
      baseUrl: patch.baseUrl === undefined ? current.baseUrl : patch.baseUrl,
      secretId: patch.secretId === undefined ? current.secretId : patch.secretId,
      enabled: patch.enabled ?? current.enabled,
    };
    try {
      this.db.run(
        `update assistant_providers set name = ?, base_url = ?, secret_id = ?, enabled = ?, updated_at = ?
         where id = ?`,
        next.name,
        next.baseUrl ?? null,
        next.secretId ?? null,
        next.enabled ? 1 : 0,
        this.now(),
        id,
      );
    } catch (err) {
      if (isUniqueViolation(err))
        throw new CoreError("already_exists", undefined, { name: next.name });
      throw err;
    }
    return this.require(id);
  }

  /** Removes the provider and its model rows. The caller deletes the secret. */
  delete(id: string): boolean {
    return this.db.tx(() => {
      this.db.run("delete from assistant_models where provider_id = ?", id);
      return this.db.run("delete from assistant_providers where id = ?", id).changes > 0;
    });
  }

  listModels(providerId: string): ProviderModelRow[] {
    return this.db
      .all(
        "select provider_id, model_id, enabled from assistant_models where provider_id = ? order by model_id",
        providerId,
      )
      .map((r) => ({
        providerId: r.provider_id as string,
        modelId: r.model_id as string,
        enabled: r.enabled === 1,
      }));
  }

  /**
   * Replaces the remembered model list with what the endpoint reported. Enabled models stay even
   * when the endpoint stopped listing them, so a hiccup never silently switches a model off.
   */
  setListed(providerId: string, listed: readonly string[]): void {
    this.db.tx(() => {
      const keep = new Set(listed);
      for (const m of this.listModels(providerId))
        if (!keep.has(m.modelId) && !m.enabled)
          this.db.run(
            "delete from assistant_models where provider_id = ? and model_id = ?",
            providerId,
            m.modelId,
          );
      for (const modelId of keep)
        this.db.run(
          "insert into assistant_models (provider_id, model_id, enabled) values (?, ?, 0) on conflict do nothing",
          providerId,
          modelId,
        );
    });
  }

  /** Switches exactly `enabled` on and every other known model of the provider off. */
  setEnabled(providerId: string, enabled: readonly string[]): void {
    this.db.tx(() => {
      this.db.run("update assistant_models set enabled = 0 where provider_id = ?", providerId);
      for (const modelId of new Set(enabled))
        this.db.run(
          `insert into assistant_models (provider_id, model_id, enabled) values (?, ?, 1)
           on conflict (provider_id, model_id) do update set enabled = 1`,
          providerId,
          modelId,
        );
    });
  }

  enabledModels(): ProviderModelRow[] {
    return this.db
      .all(
        "select provider_id, model_id, enabled from assistant_models where enabled = 1 order by provider_id, model_id",
      )
      .map((r) => ({
        providerId: r.provider_id as string,
        modelId: r.model_id as string,
        enabled: true,
      }));
  }
}
