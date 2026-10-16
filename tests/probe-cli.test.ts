import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatProbeResultJson,
  parseProbeArgs,
  probeBit,
  sepBit,
  type ProbeResult,
} from "@corridor/probe";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const PROBE_SCRIPT = fileURLToPath(new URL("../examples/probe-anchor.ts", import.meta.url));

function runProbe(args: string[]) {
  return spawnSync(process.execPath, [TSX_CLI, PROBE_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

describe("probe CLI (--json flag) (#232)", () => {
  it("exits with 2 and prints usage when no domain is provided", () => {
    const res = runProbe([]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage: pnpm probe:anchor <home-domain> [--json]");
    expect(res.stdout).toBe("");
  });

  it("exits with 2 and prints usage when only --json is provided", () => {
    const res = runProbe(["--json"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage: pnpm probe:anchor <home-domain> [--json]");
    expect(res.stdout).toBe("");
  });

  it("parses --json flag regardless of position in argv", () => {
    expect(parseProbeArgs(["example.com"])).toEqual({ domain: "example.com", json: false });
    expect(parseProbeArgs(["example.com", "--json"])).toEqual({
      domain: "example.com",
      json: true,
    });
    expect(parseProbeArgs(["--json", "example.com"])).toEqual({
      domain: "example.com",
      json: true,
    });
  });

  it("formats ProbeResult into valid, parseable JSON data structure", () => {
    const fixture: ProbeResult = {
      domain: "testanchor.stellar.org",
      seps: sepBit(1) | sepBit(10) | sepBit(12) | sepBit(31) | sepBit(38),
      probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
      probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
      tomlHash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      outcomes: [
        { probe: "toml_fetch", passed: true, detail: "fetched" },
        { probe: "sep10_auth", passed: true, detail: "auth ok" },
        { probe: "sep31_info", passed: false, detail: "empty receive" },
      ],
    };

    const formattedJson = formatProbeResultJson(fixture);
    expect(() => JSON.parse(formattedJson)).not.toThrow();

    const data = JSON.parse(formattedJson);
    expect(data.domain).toBe(fixture.domain);
    expect(data.tomlHash).toBe(fixture.tomlHash);
    expect(data.seps).toEqual([1, 10, 12, 31, 38]);
    expect(data.probesPassed).toEqual(["toml_fetch", "sep10_auth"]);
    expect(data.probesRun).toEqual(["toml_fetch", "sep10_auth", "sep31_info"]);
    expect(data.raw).toEqual({
      seps: fixture.seps,
      probesRun: fixture.probesRun,
      probesPassed: fixture.probesPassed,
    });
    expect(data.outcomes).toHaveLength(3);
  });
});
