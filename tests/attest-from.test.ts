import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatProbeResultJson,
  loadProbeResultsFromFile,
  parseAttestArgs,
  parseProbeResults,
  probeBit,
  sepBit,
  type ProbeResult,
} from "@corridor/probe";

const VALID_TOML_HASH = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";

const sampleResult: ProbeResult = {
  domain: "testanchor.stellar.org",
  seps: sepBit(1) | sepBit(10) | sepBit(31),
  probesRun: probeBit("toml_fetch") | probeBit("sep10_auth") | probeBit("sep31_info"),
  probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
  tomlHash: VALID_TOML_HASH,
  outcomes: [
    { probe: "toml_fetch", passed: true, detail: "fetched" },
    { probe: "sep10_auth", passed: true, detail: "auth ok" },
    { probe: "sep31_info", passed: false, detail: "empty receive" },
  ],
};

describe("attest-from probe results loader (#238)", () => {
  it("parses valid ProbeResult array", () => {
    const results = parseProbeResults([sampleResult]);
    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe("testanchor.stellar.org");
    expect(results[0].seps).toBe(sampleResult.seps);
    expect(results[0].probesRun).toBe(sampleResult.probesRun);
    expect(results[0].probesPassed).toBe(sampleResult.probesPassed);
    expect(results[0].tomlHash).toBe(VALID_TOML_HASH);
    expect(results[0].outcomes).toHaveLength(3);
  });

  it("parses valid JSON string formatted with formatProbeResultJson", () => {
    const jsonStr = JSON.stringify([JSON.parse(formatProbeResultJson(sampleResult))]);
    const results = parseProbeResults(jsonStr);
    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe("testanchor.stellar.org");
    expect(results[0].seps).toBe(sampleResult.seps);
    expect(results[0].probesRun).toBe(sampleResult.probesRun);
    expect(results[0].probesPassed).toBe(sampleResult.probesPassed);
  });

  it("parses a single result object directly", () => {
    const results = parseProbeResults(sampleResult);
    expect(results).toHaveLength(1);
    expect(results[0].domain).toBe("testanchor.stellar.org");
  });

  it("rejects dishonest results where probesPassed exceeds probesRun", () => {
    const dishonest: ProbeResult = {
      domain: "dishonest.anchor.org",
      seps: sepBit(1),
      probesRun: probeBit("toml_fetch"),
      // Claims sep10_auth passed even though it was not run!
      probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
      tomlHash: VALID_TOML_HASH,
      outcomes: [],
    };

    expect(() => parseProbeResults([dishonest])).toThrowError(
      /refusing to submit a result claiming probes passed that were never run/,
    );
  });

  it("rejects malformed JSON", () => {
    expect(() => parseProbeResults("{not valid json")).toThrowError(/Malformed JSON/);
  });

  it("rejects non-object or null input", () => {
    expect(() => parseProbeResults(null)).toThrowError(/must be a non-null object or array/);
    expect(() => parseProbeResults("123")).toThrowError(/must be a non-null object or array/);
  });

  it("rejects missing or empty domain", () => {
    expect(() =>
      parseProbeResults([
        {
          ...sampleResult,
          domain: "",
        },
      ]),
    ).toThrowError(/missing a valid domain/);
  });

  it("rejects invalid tomlHash", () => {
    expect(() =>
      parseProbeResults([
        {
          ...sampleResult,
          tomlHash: "not-a-64-char-hex-hash",
        },
      ]),
    ).toThrowError(/invalid tomlHash/);
  });

  it("rejects negative or non-integer bitmap fields", () => {
    expect(() =>
      parseProbeResults([
        {
          ...sampleResult,
          seps: -1,
        },
      ]),
    ).toThrowError(/missing valid bitmap fields/);

    expect(() =>
      parseProbeResults([
        {
          ...sampleResult,
          probesRun: 1.5,
        },
      ]),
    ).toThrowError(/missing valid bitmap fields/);
  });

  it("loads probe results from file correctly", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "attest-test-"));
    const filePath = join(tmpDir, "sweep.json");
    try {
      writeFileSync(filePath, JSON.stringify([sampleResult]), "utf8");
      const loaded = loadProbeResultsFromFile(filePath);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].domain).toBe("testanchor.stellar.org");
      expect(loaded[0].probesPassed).toBe(sampleResult.probesPassed);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses CLI args for attest correctly", () => {
    expect(parseAttestArgs([])).toEqual({ from: undefined, domains: [] });
    expect(parseAttestArgs(["--from", "sweep.json"])).toEqual({
      from: "sweep.json",
      domains: [],
    });
    expect(parseAttestArgs(["--from=sweep.json"])).toEqual({
      from: "sweep.json",
      domains: [],
    });
    expect(parseAttestArgs(["--from", "sweep.json", "example.com"])).toEqual({
      from: "sweep.json",
      domains: ["example.com"],
    });
    expect(parseAttestArgs(["example.com", "other.com"])).toEqual({
      from: undefined,
      domains: ["example.com", "other.com"],
    });
  });
});

describe("attest-from metadata round trip (#242)", () => {
  const withMeta: ProbeResult = {
    ...sampleResult,
    probesPassed: sampleResult.probesPassed | probeBit("sep31_info"),
    receiveAssets: ["NGN", "KES"],
    country: "NG",
  };

  /** Serialize the way a sweep writes its results file, then load it back. */
  const roundTrip = (result: ProbeResult): ProbeResult =>
    parseProbeResults(JSON.stringify([JSON.parse(formatProbeResultJson(result))]))[0];

  it("carries the observed list and declared country through the file", () => {
    const loaded = roundTrip(withMeta);
    expect(loaded.receiveAssets).toEqual(["NGN", "KES"]);
    expect(loaded.country).toBe("NG");
  });

  it("carries an empty list as the finding rather than dropping it", () => {
    const loaded = roundTrip({ ...withMeta, receiveAssets: [] });
    expect(loaded.receiveAssets).toEqual([]);
  });

  it("accepts the list under the name sep31ReceiveAssets and exposes both names", () => {
    const loaded = parseProbeResults([
      { ...sampleResult, sep31ReceiveAssets: ["NGN", "KES"] },
    ])[0]!;
    expect(loaded.receiveAssets).toEqual(["NGN", "KES"]);
    expect(loaded.sep31ReceiveAssets).toEqual(["NGN", "KES"]);
  });

  it("applies the same checks to sep31ReceiveAssets", () => {
    expect(() =>
      parseProbeResults({ ...sampleResult, sep31ReceiveAssets: ["NGN", ""] }),
    ).toThrow(/invalid receiveAssets/);
  });

  it("loads a result written before metadata existed", () => {
    const loaded = roundTrip(sampleResult);
    expect("receiveAssets" in loaded).toBe(false);
    expect("country" in loaded).toBe(false);
  });

  it("refuses a country that is not alpha-2", () => {
    expect(() => parseProbeResults({ ...sampleResult, country: "Nigeria" })).toThrow(
      /invalid country/,
    );
    expect(() => parseProbeResults({ ...sampleResult, country: "Ng" })).toThrow(
      /invalid country/,
    );
  });

  it("refuses a receive list that is not a list of codes", () => {
    expect(() => parseProbeResults({ ...sampleResult, receiveAssets: "NGN,KES" })).toThrow(
      /invalid receiveAssets/,
    );
    expect(() => parseProbeResults({ ...sampleResult, receiveAssets: ["NGN", ""] })).toThrow(
      /invalid receiveAssets/,
    );
  });
});
