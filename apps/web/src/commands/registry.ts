import { useSyncExternalStore } from "react";
import type { IconName } from "../ui/index.ts";

/** One thing the command palette can run. */
export interface Command {
  id: string;
  /** Already translated. */
  title: string;
  /** Shown to the right, e.g. the keyboard shortcut. */
  hint?: string;
  icon?: IconName;
  run: () => void;
}

let commands: readonly Command[] = [];
const listeners = new Set<() => void>();

function emit(next: readonly Command[]): void {
  commands = next;
  for (const listener of listeners) listener();
}

/**
 * Adds commands to the palette; returns a function that removes them again. A command with an
 * id that is already registered replaces it. Plugins will register theirs the same way.
 */
export function registerCommands(added: readonly Command[]): () => void {
  const ids = new Set(added.map((c) => c.id));
  emit([...commands.filter((c) => !ids.has(c.id)), ...added]);
  return () => emit(commands.filter((c) => !added.includes(c)));
}

export function useCommands(): readonly Command[] {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => commands,
    () => commands,
  );
}
