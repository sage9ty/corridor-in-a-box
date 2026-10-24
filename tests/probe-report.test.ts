import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSweepJson,
  buildSweepMarkdown,
  buildSweepReport,
  buildSweepReportEntry,
  extractReceiveAssets,
  isUsableSep31,
  parseSweepArgs,
  probeBit,
  isUsableSep31OffRamp,
  parseProbeResults,
  renderSweepJson,
  renderSweepReportJson,
  renderSweepMarkdown,
  sepBit,
  sweepAnchors,
  type ProbeResult,
  type SweepReportEntry,
} from "@corridor/probe";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const SWEEP_SCRIPT = fileURLToPath(new URL("../examples/sweep-anchors.ts", import.meta.url));

const COWRIE_FIXTURE: ProbeResult = {
  domain: "cowrie.exchange",
  seps: sepBit(1) | sepBit(10) | sepBit(31),
  probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
  probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
  tomlHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  receiveAssets: ["NGNT", "USDC"],
  outcomes: [
    { probe: "toml_fetch", passed: true, detail: "sha256 abcdef0123456789…" },
    { probe: "sep10_auth", passed: true, detail: "challenge signed, JWT issued" },
    { probe: "sep31_info", passed: true, detail: "receives NGNT, USDC" },
  ],
};

const TESTANCHOR_FIXTURE: ProbeResult = {
  domain: "testanchor.stellar.org",
  seps: sepBit(1) | sepBit(10) | sepBit(12) | sepBit(31) | sepBit(38),
  probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
  probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
  tomlHash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  receiveAssets: [],
  outcomes: [
    { probe: "toml_fetch", passed: true, detail: "sha256 1234567890abcdef…" },
    { probe: "sep10_auth", passed: true, detail: "challenge signed, JWT issued" },
    {
      probe: "sep31_info",
      passed: false,
      detail: "receive list is EMPTY — advertises SEP-31 but accepts nothing",
    },
  ],
};

const TOML_FETCH_FAILURE_FIXTURE: ProbeResult = {
  domain: "broken.example.com",
  seps: 0,
  probesRun: probeBit("toml_fetch"),
  probesPassed: 0,
  tomlHash: "0".repeat(64),
  receiveAssets: [],
  outcomes: [{ probe: "toml_fetch", passed: false, detail: "fetch failed HTTP 404" }],
};

describe("pure report builders (@corridor/probe/report)", () => {
  const fixtures: ProbeResult[] = [
    COWRIE_FIXTURE,
    TESTANCHOR_FIXTURE,
    TOML_FETCH_FAILURE_FIXTURE,
  ];

  describe("isUsableSep31", () => {
    it("returns true only when SEP-31 is advertised AND sep31_info probe passed", () => {
      expect(isUsableSep31(COWRIE_FIXTURE)).toBe(true);
      expect(isUsableSep31(TESTANCHOR_FIXTURE)).toBe(false);
      expect(isUsableSep31(TOML_FETCH_FAILURE_FIXTURE)).toBe(false);
    });

    it("returns false if sep31_info passed but SEP-31 is not advertised", () => {
      const anomaly: ProbeResult = {
        domain: "anomaly.example.com",
        seps: sepBit(1) | sepBit(10), // SEP-31 not in bitmask
        probesRun: probeBit("toml_fetch") | probeBit("sep31_info"),
        probesPassed: probeBit("toml_fetch") | probeBit("sep31_info"),
        tomlHash: "aabbcc",
        outcomes: [{ probe: "sep31_info", passed: true, detail: "receives USDC" }],
      };
      expect(isUsableSep31(anomaly)).toBe(false);
    });
  });

  describe("extractReceiveAssets", () => {
    it("extracts from sep31ReceiveAssets property if present", () => {
      const withSep31: ProbeResult = {
        ...COWRIE_FIXTURE,
        sep31ReceiveAssets: ["NGNT", "USDC"],
        receiveAssets: undefined,
      };
      expect(extractReceiveAssets(withSep31)).toEqual(["NGNT", "USDC"]);
    });

    it("extracts from receiveAssets property if present", () => {
      expect(extractReceiveAssets(COWRIE_FIXTURE)).toEqual(["NGNT", "USDC"]);
    });

    it("parses receives from outcome detail when receiveAssets is omitted", () => {
      const withoutProperty: ProbeResult = {
        ...COWRIE_FIXTURE,
        sep31ReceiveAssets: undefined,
        receiveAssets: undefined,
      };
      expect(extractReceiveAssets(withoutProperty)).toEqual(["NGNT", "USDC"]);
    });

    it("returns empty array when receive list is empty or probe failed", () => {
      expect(extractReceiveAssets(TESTANCHOR_FIXTURE)).toEqual([]);
      expect(extractReceiveAssets(TOML_FETCH_FAILURE_FIXTURE)).toEqual([]);
    });
  });

  describe("decoded report rendering (sweep-report.json)", () => {
    it("renders valid JSON array of decoded results with receive assets and timestamp", () => {
      const fixedTimestamp = "2026-10-17T15:00:00.000Z";
      const jsonStr = renderSweepReportJson(fixtures, { timestamp: fixedTimestamp });

      expect(() => JSON.parse(jsonStr)).not.toThrow();
      const parsed = JSON.parse(jsonStr) as SweepReportEntry[];

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(3);

      // 1. Working anchor (Cowrie)
      const cowrie = parsed[0];
      expect(cowrie.domain).toBe("cowrie.exchange");
      expect(cowrie.timestamp).toBe(fixedTimestamp);
      expect(cowrie.seps).toEqual([1, 10, 31]);
      expect(cowrie.probesRun).toEqual(["toml_fetch", "sep10_auth", "sep31_info"]);
      expect(cowrie.probesPassed).toEqual(["toml_fetch", "sep10_auth", "sep31_info"]);
      expect(cowrie.probesFailed).toEqual([]);
      expect(cowrie.receiveAssets).toEqual(["NGNT", "USDC"]);
      expect(cowrie.usableSep31).toBe(true);
      expect(cowrie.usableSep31OffRamp).toBe("yes");
      expect(cowrie.tomlHash).toBe(COWRIE_FIXTURE.tomlHash);
      expect(cowrie.raw.seps).toBe(COWRIE_FIXTURE.seps);

      // 2. Anchor with empty receive list (testanchor)
      const testanchor = parsed[1];
      expect(testanchor.domain).toBe("testanchor.stellar.org");
      expect(testanchor.seps).toEqual([1, 10, 12, 31, 38]);
      expect(testanchor.probesRun).toEqual(["toml_fetch", "sep10_auth", "sep31_info"]);
      expect(testanchor.probesPassed).toEqual(["toml_fetch", "sep10_auth"]);
      expect(testanchor.probesFailed).toEqual(["sep31_info"]);
      expect(testanchor.receiveAssets).toEqual([]);
      expect(testanchor.usableSep31).toBe(false);
      expect(testanchor.usableSep31OffRamp).toBe("no");

      // 3. toml_fetch failure row
      const broken = parsed[2];
      expect(broken.domain).toBe("broken.example.com");
      expect(broken.seps).toEqual([]);
      expect(broken.probesRun).toEqual(["toml_fetch"]);
      expect(broken.probesPassed).toEqual([]);
      expect(broken.probesFailed).toEqual(["toml_fetch"]);
      expect(broken.receiveAssets).toEqual([]);
      expect(broken.usableSep31).toBe(false);
      expect(broken.usableSep31OffRamp).toBe("no");
      expect(broken.tomlHash).toBe("0".repeat(64));
      expect(broken.outcomes[0]).toEqual({
        probe: "toml_fetch",
        passed: false,
        detail: "fetch failed HTTP 404",
      });
    });

    it("buildSweepJson aliases renderSweepReportJson", () => {
      const options = { timestamp: "2026-10-17T15:00:00.000Z" };
      expect(buildSweepJson(fixtures, options)).toBe(renderSweepReportJson(fixtures, options));
    });

    it("renderSweepJson keeps the exact ProbeResults so `attest --from` can load them", () => {
      const parsed = JSON.parse(renderSweepJson(fixtures)) as ProbeResult[];
      expect(parsed).toHaveLength(3);
      // Bitmasks stay numeric: the decoded report is a separate file.
      expect(parsed[0].seps).toBe(COWRIE_FIXTURE.seps);
      expect(parsed[0].probesPassed).toBe(COWRIE_FIXTURE.probesPassed);
      expect(parseProbeResults(renderSweepJson(fixtures)).map((r) => r.domain)).toEqual(
        fixtures.map((r) => r.domain),
      );
    });

    it("isUsableSep31OffRamp is the same predicate as isUsableSep31", () => {
      for (const f of fixtures) {
        expect(isUsableSep31OffRamp(f)).toBe(isUsableSep31(f));
      }
    });

    it("builds sweep report entries with buildSweepReport and buildSweepReportEntry", () => {
      const entry = buildSweepReportEntry(COWRIE_FIXTURE, "2026-10-17T15:00:00.000Z");
      expect(entry.domain).toBe("cowrie.exchange");
      expect(entry.usableSep31).toBe(true);
      expect(entry.receiveAssets).toEqual(["NGNT", "USDC"]);

      const entries = buildSweepReport(fixtures);
      expect(entries).toHaveLength(3);
    });
  });

  describe("Markdown rendering (sweep.md)", () => {
    it("renders table with advertised SEPs, passed probes, failed probes with detail, and usable SEP-31 off-ramp yes/no", () => {
      const fixedTimestamp = "2026-10-17T15:00:00.000Z";
      const md = renderSweepMarkdown(fixtures, { timestamp: fixedTimestamp });

      // Table headers
      expect(md).toContain("# Anchor Sweep Report");
      expect(md).toContain(`Generated at: ${fixedTimestamp}`);
      expect(md).toContain(
        "| Domain | Advertised SEPs | Passed Probes | Failed Probes (Detail) | Usable SEP-31 off-ramp |",
      );
      expect(md).toContain("| --- | --- | --- | --- | --- |");

      // Cowrie row: everything passed, usable = yes
      expect(md).toContain(
        "| cowrie.exchange | SEP-1, SEP-10, SEP-31 | toml_fetch, sep10_auth, sep31_info | none | yes |",
      );

      // Testanchor row: sep31_info failed with empty receive detail, usable = no
      expect(md).toContain(
        "| testanchor.stellar.org | SEP-1, SEP-10, SEP-12, SEP-31, SEP-38 | toml_fetch, sep10_auth | sep31_info: receive list is EMPTY — advertises SEP-31 but accepts nothing | no |",
      );

      // toml-fetch failure row: advertised = none, passed = none, failed = toml_fetch with detail, usable = no
      expect(md).toContain(
        "| broken.example.com | none | none | toml_fetch: fetch failed HTTP 404 | no |",
      );
    });

    it("escapes pipe characters in probe detail to preserve table formatting", () => {
      const withPipe: ProbeResult = {
        domain: "pipe.example.com",
        seps: 0,
        probesRun: probeBit("toml_fetch"),
        probesPassed: 0,
        tomlHash: "0".repeat(64),
        outcomes: [{ probe: "toml_fetch", passed: false, detail: "error: a | b | c" }],
      };
      const md = renderSweepMarkdown([withPipe]);
      expect(md).toContain("error: a \\| b \\| c");
    });

    it("escapes backslashes first so an escaped pipe in the detail cannot reopen the cell", () => {
      const withBackslash: ProbeResult = {
        domain: "backslash.example.com",
        seps: 0,
        probesRun: probeBit("toml_fetch"),
        probesPassed: 0,
        tomlHash: "0".repeat(64),
        outcomes: [{ probe: "toml_fetch", passed: false, detail: "path C:\\x \\| y" }],
      };
      const md = renderSweepMarkdown([withBackslash]);
      // `\` -> `\\` and `|` -> `\|`, so the detail's own `\|` becomes `\\\|`.
      expect(md).toContain("path C:\\\\x \\\\\\| y");
    });

    it("buildSweepMarkdown aliases renderSweepMarkdown", () => {
      const options = { timestamp: "2026-10-17T15:00:00.000Z" };
      expect(buildSweepMarkdown(fixtures, options)).toBe(
        renderSweepMarkdown(fixtures, options),
      );
    });
  });

  describe("parseSweepArgs", () => {
    it("parses --out and domains from argv", () => {
      const res = parseSweepArgs(["--out", "/tmp/sweep", "anchor1.com", "anchor2.com"]);
      expect(res.outDir).toBe("/tmp/sweep");
      expect(res.domains).toEqual(["anchor1.com", "anchor2.com"]);
      expect(res.concurrency).toBeUndefined();
    });

    it("parses --out=<path> format", () => {
      const res = parseSweepArgs(["--out=/custom/path"]);
      expect(res.outDir).toBe("/custom/path");
      expect(res.domains).toEqual([]);
    });

    it("parses --concurrency argument", () => {
      const res = parseSweepArgs(["--concurrency", "8", "--out=/tmp/sweep"]);
      expect(res.concurrency).toBe(8);
      expect(res.outDir).toBe("/tmp/sweep");
    });
  });

  describe("sweepAnchors concurrency and error handling", () => {
    it("sweeps domains with bounded concurrency and preserves order", async () => {
      let activePromises = 0;
      let maxActivePromises = 0;

      const mockProbe = async (domain: string): Promise<ProbeResult> => {
        activePromises++;
        maxActivePromises = Math.max(maxActivePromises, activePromises);
        await new Promise((r) => setTimeout(r, 20));
        activePromises--;

        return {
          domain,
          seps: sepBit(1),
          probesRun: probeBit("toml_fetch"),
          probesPassed: probeBit("toml_fetch"),
          tomlHash: "abcd",
          outcomes: [{ probe: "toml_fetch", passed: true, detail: "ok" }],
        };
      };

      const domains = ["d1.com", "d2.com", "d3.com", "d4.com", "d5.com", "d6.com"];
      const results = await sweepAnchors(domains, {
        concurrency: 2,
        probeFn: mockProbe,
      });

      expect(maxActivePromises).toBeLessThanOrEqual(2);
      expect(results.map((r) => r.domain)).toEqual(domains);
    });

    it("safely handles unexpected exceptions from probeFn without failing the sweep", async () => {
      const throwingProbe = async (domain: string): Promise<ProbeResult> => {
        if (domain === "crash.com") {
          throw new Error("DNS lookup timeout");
        }
        return COWRIE_FIXTURE;
      };

      const results = await sweepAnchors(["crash.com"], { probeFn: throwingProbe });
      expect(results).toHaveLength(1);
      expect(results[0].domain).toBe("crash.com");
      expect(results[0].probesPassed).toBe(0);
      expect(results[0].outcomes[0].detail).toContain("DNS lookup timeout");
    });
  });

  describe("CLI execution (sweep:anchors --out)", () => {
    it("pnpm sweep:anchors --out produces sweep.json, sweep.md and sweep-report.json", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "sweep-test-"));
      try {
        const res = spawnSync(
          process.execPath,
          [TSX_CLI, SWEEP_SCRIPT, "--out", tempDir, "testanchor.stellar.org"],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            timeout: 30_000,
          },
        );

        expect(res.status).toBe(0);

        const jsonFile = join(tempDir, "sweep.json");
        const mdFile = join(tempDir, "sweep.md");

        expect(existsSync(jsonFile)).toBe(true);
        expect(existsSync(mdFile)).toBe(true);

        const jsonContent = JSON.parse(readFileSync(jsonFile, "utf8"));
        expect(Array.isArray(jsonContent)).toBe(true);
        expect(jsonContent.length).toBeGreaterThanOrEqual(1);
        expect(jsonContent[0].domain).toBe("testanchor.stellar.org");
        // sweep.json is the attestable one: numeric bitmasks, loadable by `attest --from`.
        expect(typeof jsonContent[0].seps).toBe("number");
        expect(parseProbeResults(readFileSync(jsonFile, "utf8"))).toHaveLength(
          jsonContent.length,
        );

        const reportFile = join(tempDir, "sweep-report.json");
        expect(existsSync(reportFile)).toBe(true);
        const report = JSON.parse(readFileSync(reportFile, "utf8"));
        expect(Array.isArray(report[0].seps)).toBe(true);

        const mdContent = readFileSync(mdFile, "utf8");
        expect(mdContent).toContain("# Anchor Sweep Report");
        expect(mdContent).toContain("| testanchor.stellar.org |");
        expect(mdContent).toContain("Usable SEP-31 off-ramp");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
