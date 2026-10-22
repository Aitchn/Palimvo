import type { Endpoint } from "./registry.ts";

/** What the MCP server tells every client on connect. English only; keep it short, it costs context on every session. */
export function instructions(endpoint: Endpoint): string {
  const lines = [
    "Palimvo is a knowledge base of Markdown notes, JSON Canvas files and Obsidian Bases that people and other AIs edit at the same time.",
    "Your edits are credited to you in the version history. Pass a short `reason` with every change.",
    "Prefer small edits (update_note) over rewriting whole files; they merge into what others are typing.",
    "More tools, including those of plugins enabled in a vault, are not listed here: call list_tools, then describe_tool, then call_tool.",
  ];
  lines.push(
    endpoint === "all"
      ? "This connection covers several vaults. Call list_vaults first and pass `vault` to every tool that takes it."
      : "This connection is for one vault; tools do not take a `vault` argument.",
  );
  return lines.map((l) => `- ${l}`).join("\n");
}
