// Regenerates web/lib/generated/*.json from the corridor manifests and the
// engine's state machine. Run after editing either, and commit the result:
//
//   pnpm gen:web-data
//
// CI regenerates and fails on any diff (see scripts/web-data.ts).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWebData, GENERATED_DIR } from "./web-data";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(repoRoot, GENERATED_DIR);

mkdirSync(outDir, { recursive: true });
for (const [name, contents] of Object.entries(buildWebData(repoRoot))) {
  writeFileSync(join(outDir, name), contents);
  console.log(`wrote ${GENERATED_DIR}/${name}`);
}
