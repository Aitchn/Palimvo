import { satisfiesVersion, type PluginManifest } from "@palimvo/plugin-sdk";

export type PluginProblemCode =
  "dependency_missing" | "dependency_version" | "dependency_not_running" | "dependency_cycle";

export interface PluginProblem {
  code: PluginProblemCode;
  /** The plugin it concerns. */
  dependency: string;
  message: string;
}

export interface Candidate {
  manifest: PluginManifest;
  /** Switched on and approved: the plugin would run if its dependencies can. */
  wanted: boolean;
}

/**
 * Decides which plugins can run together. A plugin runs when it is wanted and every plugin it
 * depends on is installed at an accepted version and itself runs; a cycle runs nothing. Returns
 * the problems per plugin (empty for plugins that run, or that are not wanted).
 */
export function resolveDependencies(
  candidates: readonly Candidate[],
): Map<string, PluginProblem[]> {
  const byId = new Map(candidates.map((c) => [c.manifest.id, c]));
  const running = new Set(candidates.filter((c) => c.wanted).map((c) => c.manifest.id));

  const cyclic = cycleMembers(byId);
  for (const id of cyclic) running.delete(id);

  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...running]) {
      if (problemsOf(byId.get(id)!, byId, running, cyclic).length > 0) {
        running.delete(id);
        changed = true;
      }
    }
  }

  return new Map(
    candidates.map((c) => [c.manifest.id, c.wanted ? problemsOf(c, byId, running, cyclic) : []]),
  );
}

function problemsOf(
  c: Candidate,
  byId: ReadonlyMap<string, Candidate>,
  running: ReadonlySet<string>,
  cyclic: ReadonlySet<string>,
): PluginProblem[] {
  const out: PluginProblem[] = [];
  if (cyclic.has(c.manifest.id)) {
    out.push({
      code: "dependency_cycle",
      dependency: c.manifest.id,
      message: "Its dependencies form a cycle.",
    });
    return out;
  }
  for (const [id, range] of Object.entries(c.manifest.dependencies)) {
    const dep = byId.get(id);
    if (!dep) {
      out.push({
        code: "dependency_missing",
        dependency: id,
        message: `Needs the plugin "${id}", which is not installed.`,
      });
    } else if (!satisfiesVersion(dep.manifest.version, range)) {
      out.push({
        code: "dependency_version",
        dependency: id,
        message: `Needs "${id}" ${range}, but ${dep.manifest.version} is installed.`,
      });
    } else if (!running.has(id)) {
      out.push({
        code: "dependency_not_running",
        dependency: id,
        message: `Needs "${id}", which is not approved and switched on.`,
      });
    }
  }
  return out;
}

/** Plugins that are part of a dependency cycle (including a plugin that depends on itself). */
function cycleMembers(byId: ReadonlyMap<string, Candidate>): Set<string> {
  const members = new Set<string>();
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of Object.keys(byId.get(id)!.manifest.dependencies)) {
      if (!byId.has(dep)) continue;
      const s = state.get(dep);
      if (s === "visiting") {
        for (const m of stack.slice(stack.indexOf(dep))) members.add(m);
      } else if (s === undefined) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of byId.keys()) if (!state.has(id)) visit(id);
  return members;
}
