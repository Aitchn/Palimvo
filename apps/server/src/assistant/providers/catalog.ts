import { z } from "zod";
import { AppError } from "@palimvo/core";
import raw from "./models.json" with { type: "json" };
import { EFFORT_LEVELS, type EffortLevel } from "./types.ts";

/** How a model switches thinking off: `omit` = send nothing, `undefined` = it cannot be switched off. */
export type OffMode = "omit" | "between_tools" | "disabled";

export interface ModelPrice {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelInfo {
  id: string;
  provider: "anthropic" | "openai-compatible";
  label: string;
  /** `null`: not known; the admin can set it. */
  tools: boolean | null;
  vision: boolean | null;
  contextWindow: number | null;
  /** Levels besides `off` that the model accepts. */
  efforts: EffortLevel[];
  off?: OffMode;
  price: ModelPrice | null;
}

const EffortNoOff = z.enum(["low", "medium", "high", "xhigh", "max"]);
const OffModeSchema = z.enum(["omit", "between_tools", "disabled"]);

const Entry = z.object({
  id: z.string().min(1),
  provider: z.enum(["anthropic", "openai-compatible"]),
  label: z.string().optional(),
  tools: z.boolean().nullable().optional(),
  vision: z.boolean().nullable().optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  efforts: z.array(EffortNoOff).optional(),
  off: OffModeSchema.optional(),
  price: z
    .object({
      input: z.number().min(0),
      output: z.number().min(0),
      cacheRead: z.number().min(0).optional(),
      cacheWrite: z.number().min(0).optional(),
    })
    .nullable()
    .optional(),
});
type Entry = z.infer<typeof Entry>;

/** What an admin may change per model (stored by T46; keyed by model id). */
export const ModelOverride = Entry.omit({ id: true, provider: true }).partial();
export type ModelOverride = z.infer<typeof ModelOverride>;

const BUILT_IN: Entry[] = z.array(Entry).parse(raw.models);

function toInfo(e: Entry): ModelInfo {
  return {
    id: e.id,
    provider: e.provider,
    label: e.label ?? e.id,
    tools: e.tools ?? null,
    vision: e.vision ?? null,
    contextWindow: e.contextWindow ?? null,
    efforts: e.efforts ?? [],
    off: e.off,
    price: e.price ?? null,
  };
}

/**
 * Model capabilities: the built-in list, merged with what the endpoint reports and with admin
 * overrides. A dated id such as `claude-opus-5-5-20261001` matches the entry `claude-opus-5-5`.
 */
export class ModelCatalog {
  private readonly overrides: Map<string, ModelOverride>;

  constructor(
    overrides: Record<string, ModelOverride> = {},
    private readonly builtIn: readonly Entry[] = BUILT_IN,
  ) {
    this.overrides = new Map(
      Object.entries(overrides).map(([k, v]) => [k, ModelOverride.parse(v)]),
    );
  }

  /** Capabilities of `id` as served by a provider of `provider` kind. Never throws for unknown ids. */
  get(id: string, provider: ModelInfo["provider"]): ModelInfo {
    const known = this.findBuiltIn(id, provider);
    const base: ModelInfo = known ? { ...toInfo(known), id } : toInfo({ id, provider });
    const o = this.overrides.get(id);
    if (!o) return base;
    return {
      ...base,
      ...(o.label !== undefined && { label: o.label }),
      ...(o.tools !== undefined && { tools: o.tools }),
      ...(o.vision !== undefined && { vision: o.vision }),
      ...(o.contextWindow !== undefined && { contextWindow: o.contextWindow }),
      ...(o.efforts !== undefined && { efforts: o.efforts }),
      ...("off" in o && { off: o.off }),
      ...(o.price !== undefined && { price: o.price }),
    };
  }

  /** Built-in models of this provider kind plus any extra ids the endpoint listed, deduplicated. */
  merge(listed: readonly string[], provider: ModelInfo["provider"]): ModelInfo[] {
    const ids = new Set<string>(listed);
    // Built-in entries only appear for a provider that lists nothing (a failed or empty /models).
    if (listed.length === 0)
      for (const e of this.builtIn) if (e.provider === provider) ids.add(e.id);
    return [...ids].sort().map((id) => this.get(id, provider));
  }

  /** The levels the UI may offer for this model, `off` first when the model can switch thinking off. */
  levels(id: string, provider: ModelInfo["provider"]): EffortLevel[] {
    return levelsOf(this.get(id, provider));
  }

  private findBuiltIn(id: string, provider: ModelInfo["provider"]): Entry | undefined {
    let best: Entry | undefined;
    for (const e of this.builtIn) {
      if (e.provider !== provider) continue;
      if (id === e.id) return e;
      if (id.startsWith(`${e.id}-`) && (!best || e.id.length > best.id.length)) best = e;
    }
    return best;
  }
}

export function levelsOf(info: ModelInfo): EffortLevel[] {
  if (info.efforts.length === 0 && info.off === undefined) return [];
  return info.off ? ["off", ...info.efforts] : [...info.efforts];
}

export function assertSupportedEffort(info: ModelInfo, level: EffortLevel): void {
  if (!(EFFORT_LEVELS as readonly string[]).includes(level) || !levelsOf(info).includes(level))
    throw new AppError(
      "effort_unsupported",
      400,
      { model: info.id, level },
      { message: `${info.id} does not support the reasoning level "${level}"` },
    );
}
