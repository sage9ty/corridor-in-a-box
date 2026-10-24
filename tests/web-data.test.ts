import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_STATES } from "@corridor/engine";
import { buildWebData, GENERATED_DIR } from "../scripts/web-data";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("web/ generated data", () => {
  it("is up to date with the manifests and the engine (run `pnpm gen:web-data`)", () => {
    for (const [name, contents] of Object.entries(buildWebData(repoRoot))) {
      // Compare ignoring CRLF so a Windows checkout with autocrlf still passes.
      const committed = readFileSync(join(repoRoot, GENERATED_DIR, name), "utf8");
      expect(committed.replace(/\r\n/g, "\n"), name).toBe(contents);
    }
  });

  it("carries every engine state", () => {
    const { states } = JSON.parse(buildWebData(repoRoot)["states.json"]) as {
      states: string[];
    };
    expect(states).toEqual([...ALL_STATES]);
    expect(states).toHaveLength(17);
  });
});
