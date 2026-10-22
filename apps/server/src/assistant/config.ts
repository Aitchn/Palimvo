import { AppError as CoreError } from "@palimvo/core";
import { z } from "zod";
import { SecretBox } from "../secrets/box.ts";
import type { AssistantProvider, ProviderKind, Store } from "../store/index.ts";
import {
  AnthropicProvider,
  FakeProvider,
  ModelCatalog,
  ModelOverride,
  OpenAICompatibleProvider,
  assertSupportedEffort,
  levelsOf,
  type ChatProvider,
  type EffortLevel,
  type ModelInfo,
  type ModelPrice,
} from "./providers/index.ts";
import { EFFORT_LEVELS } from "./providers/types.ts";

const OVERRIDES_KEY = "assistant.modelOverrides";
const DEFAULTS_KEY = "assistant.defaults";
const TEST_TIMEOUT_MS = 15_000;
export const ENV_ANTHROPIC = "env-anthropic";
export const ENV_OPENAI = "env-openai";

/** A provider as the admin screen sees it. Carries no key, only the last four characters. */
export interface ProviderView {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl?: string;
  /** Empty for keys too short to show a tail safely. Absent when no key is set. */
  keyLast4?: string;
  hasKey: boolean;
  /** `env`: comes from an environment variable and cannot be edited or deleted here. */
  source: "stored" | "env";
  enabled: boolean;
  enabledModelCount: number;
}

export interface ModelEntry {
  id: string;
  label: string;
  enabled: boolean;
  tools: boolean | null;
  vision: boolean | null;
  contextWindow: number | null;
  /** What the UI may offer, `off` first when the model can switch thinking off. */
  levels: EffortLevel[];
  price: ModelPrice | null;
}

export interface AssistantDefaults {
  providerId: string;
  model: string;
  effort?: EffortLevel;
}

export interface UsableModel extends ModelEntry {
  providerId: string;
  providerName: string;
  providerKind: ProviderKind;
}

export interface TestResult {
  ok: boolean;
  /** Redacted; never contains the key. */
  error?: string;
  models?: number;
}

export interface NewProviderInput {
  kind: ProviderKind;
  name: string;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}

export interface ProviderUpdate {
  name?: string | undefined;
  baseUrl?: string | null | undefined;
  apiKey?: string | undefined;
  clearKey?: boolean | undefined;
  enabled?: boolean | undefined;
}

export interface ProviderFactoryInput {
  kind: ProviderKind;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  catalog: ModelCatalog;
}

export interface AssistantConfigOptions {
  store: Store;
  box: SecretBox;
  /** Where `PALIMVO_ANTHROPIC_API_KEY` and friends are read from. */
  env?: Record<string, string | undefined>;
  /** Lets administrators add `fake` providers (tests and keyless demos). */
  allowFake?: boolean;
  /** Builds the provider for a configured endpoint; tests replace it. */
  factory?: (input: ProviderFactoryInput) => ChatProvider;
  testTimeoutMs?: number;
}

const providerKinds = ["anthropic", "openai-compatible", "fake"] as const;
export const ProviderKindSchema = z.enum(providerKinds);

/**
 * Model providers, their API keys and the models the administrator switched on (T46). Keys are
 * encrypted in SQLite, never returned by any method that feeds an API response, and only
 * `createChatProvider` hands them to a provider object inside this process.
 */
export class AssistantConfig {
  private readonly store: Store;
  private readonly box: SecretBox;
  private readonly env: Record<string, string | undefined>;
  private readonly allowFake: boolean;
  private readonly factory: (input: ProviderFactoryInput) => ChatProvider;
  private readonly testTimeoutMs: number;

  constructor(options: AssistantConfigOptions) {
    this.store = options.store;
    this.box = options.box;
    this.env = options.env ?? process.env;
    this.allowFake = options.allowFake ?? this.env.PALIMVO_ASSISTANT_ALLOW_FAKE === "1";
    this.factory = options.factory ?? defaultFactory;
    this.testTimeoutMs = options.testTimeoutMs ?? TEST_TIMEOUT_MS;
  }

  // ---- providers ----------------------------------------------------------------------------

  list(): ProviderView[] {
    const enabledBy = new Map<string, number>();
    for (const m of this.store.assistant.enabledModels())
      enabledBy.set(m.providerId, (enabledBy.get(m.providerId) ?? 0) + 1);
    const count = (id: string) => enabledBy.get(id) ?? 0;
    return [
      ...this.envProviders().map((p) => this.viewOfEnv(p, count(p.id))),
      ...this.store.assistant.list().map((p) => this.viewOf(p, count(p.id))),
    ];
  }

  get(id: string): ProviderView {
    const view = this.list().find((p) => p.id === id);
    if (!view) throw new CoreError("not_found", undefined, { provider: id });
    return view;
  }

  create(input: NewProviderInput): ProviderView {
    this.assertKind(input.kind);
    const name = cleanName(input.name);
    const baseUrl = this.resolveBaseUrl(input.kind, input.baseUrl);
    const apiKey = cleanKey(input.apiKey);
    if (input.kind === "anthropic" && !apiKey)
      throw new CoreError("invalid_request", undefined, { reason: "an API key is required" });
    const id = this.store.tx(() => {
      const secretId = apiKey ? this.storeKey(undefined, apiKey) : undefined;
      return this.store.assistant.create({
        kind: input.kind,
        name,
        ...(baseUrl ? { baseUrl } : {}),
        ...(secretId ? { secretId } : {}),
      }).id;
    });
    return this.get(id);
  }

  update(id: string, patch: ProviderUpdate): ProviderView {
    const current = this.requireStored(id);
    const apiKey = cleanKey(patch.apiKey);
    if (apiKey && patch.clearKey)
      throw new CoreError("invalid_request", undefined, {
        reason: "set a key or clear it, not both",
      });
    this.store.tx(() => {
      let secretId: string | null | undefined;
      if (apiKey) secretId = this.storeKey(current.secretId, apiKey);
      else if (patch.clearKey) {
        if (current.kind === "anthropic")
          throw new CoreError("invalid_request", undefined, { reason: "an API key is required" });
        secretId = null;
      }
      this.store.assistant.update(id, {
        ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
        ...(patch.baseUrl !== undefined
          ? { baseUrl: this.resolveBaseUrl(current.kind, patch.baseUrl ?? undefined) ?? null }
          : {}),
        ...(secretId !== undefined ? { secretId } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      });
      if (patch.enabled === false && this.defaults()?.providerId === id)
        this.store.settings.delete(DEFAULTS_KEY);
      if (secretId === null && current.secretId) this.store.secrets.delete(current.secretId);
    });
    return this.get(id);
  }

  delete(id: string): void {
    const current = this.requireStored(id);
    this.store.tx(() => {
      this.store.assistant.delete(id);
      if (current.secretId) this.store.secrets.delete(current.secretId);
      if (this.defaults()?.providerId === id) this.store.settings.delete(DEFAULTS_KEY);
    });
  }

  /** Asks the endpoint for its model list with the stored key. */
  async test(id: string): Promise<TestResult> {
    const secret = this.secretOf(id);
    try {
      const models = await this.listRemote(id);
      return { ok: true, models: models.length };
    } catch (err) {
      return { ok: false, error: redact(errorText(err), secret) };
    }
  }

  /**
   * The provider object for the agent loop (T47). The key is decrypted here and goes nowhere
   * else. Throws when the provider is switched off.
   */
  createChatProvider(id: string): ChatProvider {
    const view = this.get(id);
    if (!view.enabled) throw new CoreError("not_found", undefined, { provider: id });
    const apiKey = this.secretOf(id);
    return this.factory({
      kind: view.kind,
      apiKey,
      baseUrl: view.baseUrl,
      catalog: this.catalog(),
    });
  }

  // ---- models -------------------------------------------------------------------------------

  /** Capabilities merged from the built-in list and the administrator's overrides. */
  catalog(): ModelCatalog {
    return new ModelCatalog(this.store.settings.get<Record<string, ModelOverride>>(OVERRIDES_KEY));
  }

  models(providerId: string): ModelEntry[] {
    const view = this.get(providerId);
    const catalog = this.catalog();
    const kind = catalogKind(view.kind);
    return this.store.assistant
      .listModels(providerId)
      .map((m) => entryOf(catalog.get(m.modelId, kind), m.enabled));
  }

  /** Reads the endpoint's list, remembers it and returns it with capabilities. */
  async refreshModels(providerId: string): Promise<ModelEntry[]> {
    const secret = this.secretOf(providerId);
    let listed: string[];
    try {
      listed = await this.listRemote(providerId);
    } catch (err) {
      throw new CoreError("unavailable", 502, undefined, {
        message: `The provider did not answer: ${redact(errorText(err), secret)}`,
      });
    }
    this.store.assistant.setListed(providerId, listed);
    return this.models(providerId);
  }

  /** Switches exactly these models on for the provider. Unknown ids are added as they are. */
  setEnabledModels(providerId: string, modelIds: readonly string[]): ModelEntry[] {
    this.get(providerId);
    const ids = [...new Set(modelIds.map((m) => m.trim()).filter(Boolean))];
    this.store.tx(() => {
      this.store.assistant.setEnabled(providerId, ids);
      const d = this.defaults();
      if (d?.providerId === providerId && !ids.includes(d.model))
        this.store.settings.delete(DEFAULTS_KEY);
    });
    return this.models(providerId);
  }

  overrides(): Record<string, ModelOverride> {
    return this.store.settings.get<Record<string, ModelOverride>>(OVERRIDES_KEY) ?? {};
  }

  /** `null` removes the override. */
  setOverride(modelId: string, override: ModelOverride | null): void {
    const all = { ...this.overrides() };
    if (override === null) delete all[modelId];
    else all[modelId] = ModelOverride.parse(override);
    this.store.settings.set(OVERRIDES_KEY, all);
  }

  /** Enabled models of enabled providers: what users may pick from. */
  usableModels(): UsableModel[] {
    const catalog = this.catalog();
    const out: UsableModel[] = [];
    for (const p of this.list()) {
      if (!p.enabled) continue;
      for (const m of this.store.assistant.listModels(p.id))
        if (m.enabled)
          out.push({
            ...entryOf(catalog.get(m.modelId, catalogKind(p.kind)), true),
            providerId: p.id,
            providerName: p.name,
            providerKind: p.kind,
          });
    }
    return out;
  }

  // ---- defaults -----------------------------------------------------------------------------

  defaults(): AssistantDefaults | undefined {
    return this.store.settings.get<AssistantDefaults>(DEFAULTS_KEY);
  }

  /** The model must be switched on, the level one the model supports. */
  setDefaults(input: AssistantDefaults): AssistantDefaults {
    const view = this.get(input.providerId);
    if (!view.enabled)
      throw new CoreError("invalid_request", undefined, { reason: "that provider is disabled" });
    const row = this.store.assistant.listModels(view.id).find((m) => m.modelId === input.model);
    if (!row?.enabled)
      throw new CoreError("invalid_request", undefined, { reason: "that model is not enabled" });
    if (input.effort !== undefined) {
      if (!(EFFORT_LEVELS as readonly string[]).includes(input.effort))
        throw new CoreError("effort_unsupported", undefined, { level: input.effort });
      assertSupportedEffort(this.catalog().get(input.model, catalogKind(view.kind)), input.effort);
    }
    const saved: AssistantDefaults = {
      providerId: input.providerId,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
    };
    this.store.settings.set(DEFAULTS_KEY, saved);
    return saved;
  }

  clearDefaults(): void {
    this.store.settings.delete(DEFAULTS_KEY);
  }

  // ---- internals ----------------------------------------------------------------------------

  private envProviders(): (AssistantProvider & { key: string })[] {
    const at = 0;
    const out: (AssistantProvider & { key: string })[] = [];
    const anthropic = cleanKey(this.env.PALIMVO_ANTHROPIC_API_KEY);
    if (anthropic) {
      const baseUrl = this.envBaseUrl("PALIMVO_ANTHROPIC_BASE_URL");
      out.push({
        id: ENV_ANTHROPIC,
        kind: "anthropic",
        name: "Anthropic (environment)",
        ...(baseUrl ? { baseUrl } : {}),
        enabled: true,
        createdAt: at,
        updatedAt: at,
        key: anthropic,
      });
    }
    const openai = cleanKey(this.env.PALIMVO_OPENAI_API_KEY);
    if (openai)
      out.push({
        id: ENV_OPENAI,
        kind: "openai-compatible",
        name: "OpenAI (environment)",
        baseUrl: this.envBaseUrl("PALIMVO_OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
        enabled: true,
        createdAt: at,
        updatedAt: at,
        key: openai,
      });
    return out;
  }

  private envBaseUrl(name: string): string | undefined {
    const v = this.env[name]?.trim();
    return v ? validateBaseUrl(v) : undefined;
  }

  private viewOfEnv(
    p: AssistantProvider & { key: string },
    enabledModelCount: number,
  ): ProviderView {
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...tail(p.key),
      hasKey: true,
      source: "env",
      enabled: true,
      enabledModelCount,
    };
  }

  private viewOf(p: AssistantProvider, enabledModelCount: number): ProviderView {
    const stored = p.secretId ? this.store.secrets.get(p.secretId) : undefined;
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...(stored
        ? { hasKey: true, ...(stored.last4 ? { keyLast4: stored.last4 } : {}) }
        : { hasKey: false }),
      source: "stored",
      enabled: p.enabled,
      enabledModelCount,
    };
  }

  private requireStored(id: string): AssistantProvider {
    if (id === ENV_ANTHROPIC || id === ENV_OPENAI)
      throw new CoreError("invalid_request", undefined, {
        reason: "this provider comes from an environment variable; change it there",
      });
    return this.store.assistant.require(id);
  }

  /** The plain key of a provider; internal. */
  private secretOf(id: string): string | undefined {
    const env = this.envProviders().find((p) => p.id === id);
    if (env) return env.key;
    const secretId = this.store.assistant.get(id)?.secretId;
    const stored = secretId ? this.store.secrets.get(secretId) : undefined;
    return stored ? this.box.decrypt(stored.ciphertext, stored.id) : undefined;
  }

  private async listRemote(id: string): Promise<string[]> {
    const provider = this.factory({
      ...this.inputOf(id),
      catalog: this.catalog(),
    });
    const timeout = AbortSignal.timeout(this.testTimeoutMs);
    return provider.listModels(timeout);
  }

  private inputOf(id: string): Omit<ProviderFactoryInput, "catalog"> {
    const view = this.get(id);
    return { kind: view.kind, apiKey: this.secretOf(id), baseUrl: view.baseUrl };
  }

  /** Encrypts and stores `apiKey`, reusing `existing` as the row id when there is one. */
  private storeKey(existing: string | undefined, apiKey: string): string {
    const id = existing ?? this.store.secrets.newId();
    this.store.secrets.put(id, this.box.encrypt(apiKey, id), tail(apiKey).keyLast4 ?? "");
    return id;
  }

  private assertKind(kind: ProviderKind): void {
    if (kind === "fake" && !this.allowFake)
      throw new CoreError("invalid_request", undefined, {
        reason: "fake providers are not enabled",
      });
  }

  private resolveBaseUrl(kind: ProviderKind, raw: string | undefined): string | undefined {
    if (kind === "fake") return undefined;
    const value = raw?.trim();
    if (!value) {
      if (kind === "openai-compatible")
        throw new CoreError("invalid_provider_url", undefined, {
          reason: "a base URL is required",
        });
      return undefined;
    }
    return validateBaseUrl(value);
  }
}

function defaultFactory(input: ProviderFactoryInput): ChatProvider {
  if (input.kind === "fake") return new FakeProvider();
  if (input.kind === "anthropic") {
    if (!input.apiKey) throw new CoreError("invalid_request", undefined, { reason: "no API key" });
    return new AnthropicProvider({
      apiKey: input.apiKey,
      ...(input.baseUrl ? { baseURL: input.baseUrl } : {}),
      catalog: input.catalog,
    });
  }
  if (!input.baseUrl)
    throw new CoreError("invalid_provider_url", undefined, { reason: "a base URL is required" });
  return new OpenAICompatibleProvider({
    baseURL: input.baseUrl,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    catalog: input.catalog,
  });
}

const catalogKind = (kind: ProviderKind): ModelInfo["provider"] =>
  kind === "anthropic" ? "anthropic" : "openai-compatible";

function entryOf(info: ModelInfo, enabled: boolean): ModelEntry {
  return {
    id: info.id,
    label: info.label,
    enabled,
    tools: info.tools,
    vision: info.vision,
    contextWindow: info.contextWindow,
    levels: levelsOf(info),
    price: info.price,
  };
}

function cleanName(name: string): string {
  const n = name.trim();
  if (!n || n.length > 80)
    throw new CoreError("invalid_request", undefined, {
      reason: "the name must be 1-80 characters",
    });
  return n;
}

function cleanKey(key: string | undefined): string | undefined {
  const k = key?.trim();
  return k ? k : undefined;
}

/** Last four characters, only for keys long enough that four characters give nothing away. */
function tail(key: string): { keyLast4?: string } {
  return key.length >= 16 ? { keyLast4: key.slice(-4) } : {};
}

/**
 * Only `http(s)://host[:port][/path]`. The administrator may point it anywhere, including the
 * local machine (that is how Ollama is reached); nobody else can set it.
 */
export function validateBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CoreError("invalid_provider_url", undefined, { reason: "not a URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new CoreError("invalid_provider_url", undefined, {
      reason: "must start with http:// or https://",
    });
  if (url.username || url.password)
    throw new CoreError("invalid_provider_url", undefined, {
      reason: "must not contain a user name or password",
    });
  if (url.search || url.hash)
    throw new CoreError("invalid_provider_url", undefined, {
      reason: "must not contain a query or fragment",
    });
  return url.href.replace(/\/+$/, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Removes the key (and its common leaks) from text that may be shown to the administrator. */
export function redact(text: string, key: string | undefined): string {
  let out = text;
  if (key) out = out.split(key).join("***");
  return out.replace(/(Bearer\s+)[\w.~+/=-]+/gi, "$1***").slice(0, 500);
}
