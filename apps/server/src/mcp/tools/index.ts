import type { AnyTool } from "../registry.ts";
import { entryTools } from "../entry.ts";
import { listVaults } from "./vaults.ts";

/** Every tool the server ships. T28 and T29 add the note, canvas, file, history and advanced tools here. */
export function coreTools(): AnyTool[] {
  return [listVaults, ...entryTools()];
}
