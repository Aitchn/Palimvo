import type { EffortLevel } from "./events.ts";

export interface ModelCaps {
  family: "anthropic" | "openai";
  /** levels the UI may show, besides "off" */
  efforts: EffortLevel[];
  /** how "off" is expressed; undefined = cannot be turned off */
  off?: "omit" | "between_tools" | "disabled";
}

// Draft of models.json entries (T45).
export const MODEL_CAPS: Record<string, ModelCaps> = {
  "claude-opus-5-5": { family: "anthropic", efforts: ["low", "medium", "high", "xhigh", "max"] },
  "claude-sonnet-5-5": {
    family: "anthropic",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    off: "between_tools",
  },
  "claude-opus-5": {
    family: "anthropic",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    off: "disabled",
  },
  "gpt-reasoning": { family: "openai", efforts: ["low", "medium", "high"], off: "omit" },
  "local-plain": { family: "openai", efforts: [], off: "omit" },
};

export function levelsFor(model: string): EffortLevel[] {
  const c = MODEL_CAPS[model];
  if (!c) return [];
  return c.off ? ["off", ...c.efforts] : c.efforts;
}

/** Request-body fragment for Anthropic. Never sends budget_tokens or sampling params (both 400). */
export function anthropicEffort(
  model: string,
  level: EffortLevel | undefined,
): Record<string, unknown> {
  const c = MODEL_CAPS[model];
  if (!c || c.family !== "anthropic") return {};
  if (level === "off") {
    if (c.off === "between_tools") return { thinking: { type: "between_tools" } };
    if (c.off === "disabled") return { thinking: { type: "disabled" } };
    throw new Error(`${model} cannot turn thinking off`);
  }
  const out: Record<string, unknown> = { thinking: { type: "adaptive", display: "summarized" } };
  if (level) {
    if (!c.efforts.includes(level)) throw new Error(`${model} does not support effort ${level}`);
    out.output_config = { effort: level };
  }
  return out;
}

/** Request-body fragment for OpenAI-compatible endpoints. */
export function openaiEffort(
  model: string,
  level: EffortLevel | undefined,
): Record<string, unknown> {
  const c = MODEL_CAPS[model];
  if (!c || c.family !== "openai" || !level || level === "off") return {};
  if (!c.efforts.includes(level)) throw new Error(`${model} does not support effort ${level}`);
  return { reasoning_effort: level };
}
