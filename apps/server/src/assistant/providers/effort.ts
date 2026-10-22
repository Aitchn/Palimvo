import { assertSupportedEffort, type ModelInfo } from "./catalog.ts";
import type { EffortLevel } from "./types.ts";

/**
 * Request fragment for Anthropic. Never sends `budget_tokens` or sampling parameters
 * (`temperature`, `top_p`, `top_k`): since 2026-10-21 they are rejected with a 400.
 * A level the model does not support throws; the UI only offers `catalog.levels()`.
 */
export function anthropicEffort(
  info: ModelInfo,
  level: EffortLevel | undefined,
): Record<string, unknown> {
  if (info.efforts.length === 0 && info.off === undefined) {
    // Unknown model: send nothing rather than guess a shape that might be a 400.
    if (level && level !== "off") assertSupportedEffort(info, level);
    return {};
  }
  if (level === "off") {
    assertSupportedEffort(info, level);
    // Sonnet 5.5 answers 400 to "disabled"; Opus 5 takes it; Opus 5.5 has no off (rejected above).
    if (info.off === "between_tools") return { thinking: { type: "between_tools" } };
    if (info.off === "disabled") return { thinking: { type: "disabled" } };
    return {};
  }
  const out: Record<string, unknown> = { thinking: { type: "adaptive", display: "summarized" } };
  if (level) {
    assertSupportedEffort(info, level);
    out.output_config = { effort: level };
  }
  return out;
}

/** Request fragment for OpenAI-compatible endpoints. */
export function openaiEffort(
  info: ModelInfo,
  level: EffortLevel | undefined,
): Record<string, unknown> {
  if (!level) return {};
  if (level === "off") return {};
  assertSupportedEffort(info, level);
  return { reasoning_effort: level };
}
