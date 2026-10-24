// Builds the data web/ renders, from the same sources the engine runs on.
//
// web/ is outside the pnpm workspace, and its hand-copied corridors and state
// list had already drifted from corridors/*.corridor.yaml and
// packages/engine/src/state.ts. So web/ reads these generated files instead:
//
//   web/lib/generated/corridors.json  every manifest, parsed by @corridor/manifest
//   web/lib/generated/states.json     the state machine from @corridor/engine
//
// Liveness is deliberately NOT generated: whether a proof is still fresh depends
// on today's date, so a generated value would go stale without any source
// changing. web/ calls liveness() from @corridor/manifest at render time instead.
//
// Written by scripts/gen-web-data.ts; tests/web-data.test.ts fails when the
// committed files no longer match what this produces.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { ALL_STATES, canTransition, TERMINAL } from "@corridor/engine";

export const GENERATED_DIR = "web/lib/generated";

// The lane anyone can run with no agreements. It goes first because the demo
// runner preselects the first corridor.
const FIRST = "reference-testnet";

function loadCorridors(repoRoot: string): Corridor[] {
  const dir = join(repoRoot, "corridors");
  const corridors = readdirSync(dir)
    .filter((f) => f.endsWith(".corridor.yaml"))
    .map((f) => {
      const result = loadCorridor(join(dir, f));
      if (!result.ok) throw new Error(`corridors/${f}: ${result.error.message}`);
      return result.value;
    });
  return corridors.sort((a, b) =>
    a.id === FIRST ? -1 : b.id === FIRST ? 1 : a.id.localeCompare(b.id),
  );
}

function states() {
  return {
    states: ALL_STATES,
    terminal: ALL_STATES.filter((s) => TERMINAL.has(s)),
    next: Object.fromEntries(
      ALL_STATES.map((from) => [from, ALL_STATES.filter((to) => canTransition(from, to))]),
    ),
  };
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Generated file name → contents. */
export function buildWebData(repoRoot: string): Record<string, string> {
  return {
    "corridors.json": json(loadCorridors(repoRoot)),
    "states.json": json(states()),
  };
}
