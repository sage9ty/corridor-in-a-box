import { describe, expect, it } from "vitest";
import {
  manifestFromProbe,
  parseCorridorYaml,
  type Corridor,
  type Sep31Anchor,
} from "@corridor/manifest";
import { probeBit, sepBit, type ProbeResult } from "@corridor/probe";
import { parseNewArgs } from "../packages/cli/src/new";

const FULL_TOML = `
VERSION = "2.0.0"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
WEB_AUTH_ENDPOINT = "https://a.example/auth"
KYC_SERVER = "https://a.example/sep12"
TRANSFER_SERVER = "https://a.example/sep6"
TRANSFER_SERVER_SEP0024 = "https://a.example/sep24"
DIRECT_PAYMENT_SERVER = "https://a.example/sep31"
ANCHOR_QUOTE_SERVER = "https://a.example/sep38"

[[CURRENCIES]]
code = "USDC"
issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`;

const NO_SEP31_TOML = `
VERSION = "2.0.0"
SIGNING_KEY = "GCHLHDBOKG2JWMJQBTLSL5XG6NO7ESXI2TAQKZXCXWXB5WI2X6W233PR"
WEB_AUTH_ENDPOINT = "https://a.example/auth"
KYC_SERVER = "https://a.example/sep12"
TRANSFER_SERVER = "https://a.example/sep6"
TRANSFER_SERVER_SEP0024 = "https://a.example/sep24"
`;

describe("manifestFromProbe (#250)", () => {
  it("scaffolds a verified, valid corridor manifest when probes pass", () => {
    const fixture: ProbeResult = {
      domain: "anchor.example",
      seps: sepBit(1) | sepBit(10) | sepBit(12) | sepBit(31) | sepBit(38),
      probesRun:
        probeBit("toml_fetch") |
        probeBit("sep10_auth") |
        probeBit("sep38_quote") |
        probeBit("sep12_status") |
        probeBit("sep31_info"),
      probesPassed:
        probeBit("toml_fetch") |
        probeBit("sep10_auth") |
        probeBit("sep38_quote") |
        probeBit("sep12_status") |
        probeBit("sep31_info"),
      tomlHash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      outcomes: [
        { probe: "toml_fetch", passed: true, detail: "fetched" },
        { probe: "sep10_auth", passed: true, detail: "auth ok" },
        { probe: "sep38_quote", passed: true, detail: "firm quote ok" },
        { probe: "sep12_status", passed: true, detail: "HTTP 200" },
        { probe: "sep31_info", passed: true, detail: "receives USDC, iso4217:MXN" },
      ],
    };

    const yaml = manifestFromProbe(fixture, FULL_TOML, { today: "2026-10-16" });

    // Must be valid against CorridorSchema (corridor validate)
    const outcome = parseCorridorYaml(yaml);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const corridor: Corridor = outcome.value;
    expect(corridor.dest.protocol).toBe("sep31");
    const dest = corridor.dest as Sep31Anchor;

    expect(corridor.id).toBe("anchor-example");
    expect(dest.endpoints.home_domain).toBe("anchor.example");
    expect(dest.endpoints.transfer_server_sep31).toBe("https://a.example/sep31");
    expect(dest.endpoints.web_auth).toBe("https://a.example/auth");
    expect(dest.endpoints.kyc_server).toBe("https://a.example/sep12");
    expect(dest.endpoints.quote_server).toBe("https://a.example/sep38");
    expect(dest.endpoints.endpoints_verified_at).toBe("2026-10-16");
    expect(corridor.status_note).toBeUndefined();
    expect(corridor.fx.quote_source).toBe("sep38");
    expect(corridor.dest.asset).toBe("iso4217:MXN");
    expect(corridor.settlement.network).toBe("public");
    expect(corridor.settlement.asset_issuer).toBe(
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    );
  });

  it("leaves endpoints_verified_at unset and notes failed probes when unverified", () => {
    const fixture: ProbeResult = {
      domain: "anchor.example",
      seps: sepBit(1) | sepBit(10) | sepBit(12) | sepBit(31) | sepBit(38),
      probesRun:
        probeBit("toml_fetch") |
        probeBit("sep10_auth") |
        probeBit("sep38_quote") |
        probeBit("sep31_info"),
      probesPassed: probeBit("toml_fetch") | probeBit("sep10_auth"),
      tomlHash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      outcomes: [
        { probe: "toml_fetch", passed: true, detail: "fetched" },
        { probe: "sep10_auth", passed: true, detail: "auth ok" },
        { probe: "sep38_quote", passed: false, detail: "HTTP 500" },
        { probe: "sep31_info", passed: false, detail: "receive list is EMPTY" },
      ],
    };

    const yaml = manifestFromProbe(fixture, FULL_TOML, {
      receiveAssets: ["iso4217:BRL"],
    });

    const outcome = parseCorridorYaml(yaml);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const corridor = outcome.value;
    expect(corridor.dest.endpoints.endpoints_verified_at).toBeUndefined();
    expect(corridor.status_note).toContain("sep38_quote");
    expect(corridor.status_note).toContain("sep31_info");
    expect(corridor.fx.quote_source).toBe("external");
    expect(corridor.dest.asset).toBe("iso4217:BRL");
  });

  it("refuses if SEP-31 is not advertised unless allowNotRunnable is set", () => {
    const fixture: ProbeResult = {
      domain: "anchor.example",
      seps: sepBit(1) | sepBit(6) | sepBit(24),
      probesRun: probeBit("toml_fetch"),
      probesPassed: probeBit("toml_fetch"),
      tomlHash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      outcomes: [{ probe: "toml_fetch", passed: true, detail: "fetched" }],
    };

    expect(() => manifestFromProbe(fixture, NO_SEP31_TOML)).toThrow(
      /does not advertise SEP-31/,
    );

    const allowedYaml = manifestFromProbe(fixture, NO_SEP31_TOML, {
      allowNotRunnable: true,
      destAsset: "iso4217:EUR",
    });

    const outcome = parseCorridorYaml(allowedYaml);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const dest = outcome.value.dest as Sep31Anchor;
    expect(dest.protocol).toBe("sep31");
    expect(dest.endpoints.transfer_server_sep31).toBeUndefined();
    expect(dest.endpoints.endpoints_verified_at).toBeUndefined();
  });

  it("emits a TODO for dest.asset if no iso4217 asset is found", () => {
    const fixture: ProbeResult = {
      domain: "anchor.example",
      seps: sepBit(1) | sepBit(31),
      probesRun: probeBit("toml_fetch") | probeBit("sep31_info"),
      probesPassed: probeBit("toml_fetch") | probeBit("sep31_info"),
      tomlHash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      outcomes: [
        { probe: "toml_fetch", passed: true, detail: "fetched" },
        { probe: "sep31_info", passed: true, detail: "receives USDC, BTC" },
      ],
    };

    const yaml = manifestFromProbe(fixture, FULL_TOML);
    expect(yaml).toContain("TODO");
  });

  it("supports --source-asset and testnet network configuration", () => {
    const fixture: ProbeResult = {
      domain: "testanchor.stellar.org",
      seps: sepBit(1) | sepBit(31),
      probesRun: probeBit("toml_fetch") | probeBit("sep31_info"),
      probesPassed: probeBit("toml_fetch") | probeBit("sep31_info"),
      tomlHash: "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
      outcomes: [
        { probe: "toml_fetch", passed: true, detail: "fetched" },
        { probe: "sep31_info", passed: true, detail: "receives iso4217:ARS" },
      ],
    };

    const yaml = manifestFromProbe(fixture, FULL_TOML, {
      sourceAsset: "EURC",
      network: "testnet",
    });

    const outcome = parseCorridorYaml(yaml);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.value.source.asset).toBe("EURC");
    expect(outcome.value.settlement.network).toBe("testnet");
    expect(outcome.value.settlement.asset_issuer).toBe(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
  });
});

describe("parseNewArgs (#250)", () => {
  it("parses domain and default options", () => {
    const parsed = parseNewArgs(["example.com"]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        domain: "example.com",
        sourceAsset: undefined,
        network: undefined,
        outFile: undefined,
        allowNotRunnable: false,
      },
    });
  });

  it("parses options and flags", () => {
    const parsed = parseNewArgs([
      "example.com",
      "--source-asset",
      "USDC",
      "--network",
      "testnet",
      "--out",
      "my.corridor.yaml",
      "--allow-not-runnable",
    ]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        domain: "example.com",
        sourceAsset: "USDC",
        network: "testnet",
        outFile: "my.corridor.yaml",
        allowNotRunnable: true,
      },
    });
  });

  it("fails when domain is missing", () => {
    const parsed = parseNewArgs([]);
    expect(parsed.ok).toBe(false);
  });

  it("fails on invalid network", () => {
    const parsed = parseNewArgs(["example.com", "--network", "mainnet"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('must be "public" or "testnet"');
  });
});
