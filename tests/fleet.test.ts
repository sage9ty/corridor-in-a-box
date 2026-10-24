import { describe, expect, it } from "vitest";
import { isValidAnchorDomain, loadFleet, parseFleet } from "../packages/probe/src/fleet";

describe("contracts/anchors.json fleet", () => {
  it("parses contracts/anchors.json and migrates the existing domains with honest kinds", () => {
    const fleet = loadFleet();
    expect(fleet.domains).toEqual([
      "testanchor.stellar.org",
      "cowrie.exchange",
      "mint.zeam.money",
      "stellar.org",
      "lobstr.co",
      "blindpay.com",
      "mykobo.co",
      "connect.clickpesa.com",
      "coins.ph",
      "vibrantapp.com",
      "anclap.com.ar",
      "stellar.moneygram.com",
      "mercuryo.io",
      "lightnet.io",
      "owlting.com",
      "arf.one",
      "stellar-sep-24.banxa.com",
      "flutterwave.com",
      "bitso.com",
    ]);
    expect(fleet.anchors.map((a) => ({ domain: a.domain, kind: a.kind }))).toEqual([
      { domain: "testanchor.stellar.org", kind: "test" },
      { domain: "cowrie.exchange", kind: "offramp" },
      { domain: "mint.zeam.money", kind: "offramp" },
      { domain: "stellar.org", kind: "other" },
      { domain: "lobstr.co", kind: "other" },
      { domain: "blindpay.com", kind: "other" },
      { domain: "mykobo.co", kind: "other" },
      { domain: "connect.clickpesa.com", kind: "other" },
      { domain: "coins.ph", kind: "other" },
      { domain: "vibrantapp.com", kind: "other" },
      { domain: "anclap.com.ar", kind: "offramp" },
      { domain: "stellar.moneygram.com", kind: "other" },
      { domain: "mercuryo.io", kind: "other" },
      { domain: "lightnet.io", kind: "other" },
      { domain: "owlting.com", kind: "other" },
      { domain: "arf.one", kind: "other" },
      { domain: "stellar-sep-24.banxa.com", kind: "other" },
      { domain: "flutterwave.com", kind: "other" },
      { domain: "bitso.com", kind: "other" },
    ]);
  });

  it("ensures every domain in contracts/anchors.json is unique, lowercase, and has no scheme or path", () => {
    const fleet = loadFleet();
    const seen = new Set<string>();
    for (const entry of fleet.anchors) {
      expect(seen.has(entry.domain)).toBe(false);
      seen.add(entry.domain);
      expect(entry.domain).toBe(entry.domain.toLowerCase());
      expect(entry.domain).not.toContain("://");
      expect(entry.domain).not.toContain("/");
      expect(entry.domain).not.toContain(":");
      expect(isValidAnchorDomain(entry.domain)).toBe(true);
    }
    expect(fleet.domains).toEqual(fleet.anchors.map((a) => a.domain));
  });

  it("rejects duplicate domains", () => {
    const base = loadFleet();
    expect(() =>
      parseFleet({
        anchors: [base.anchors[0], base.anchors[0]],
      }),
    ).toThrow(/duplicate anchor domain/);
  });

  it("rejects uppercase, scheme-prefixed, port-suffixed, or path-containing domains", () => {
    const valid = loadFleet().anchors[0]!;
    for (const bad of [
      "TestAnchor.stellar.org",
      "https://testanchor.stellar.org",
      "testanchor.stellar.org/sep31",
      "testanchor.stellar.org:8080",
      "localhost",
    ]) {
      expect(isValidAnchorDomain(bad)).toBe(false);
      expect(() =>
        parseFleet({
          anchors: [{ ...valid, domain: bad }],
        }),
      ).toThrow(/domain/);
    }
  });

  it("rejects a mismatch between top-level domains and anchors[].domain", () => {
    const base = loadFleet();
    expect(() =>
      parseFleet({
        domains: ["cowrie.exchange"],
        anchors: base.anchors,
      }),
    ).toThrow(/domains.*must match/);
  });

  it("rejects invalid kind, country codes, or dates", () => {
    const valid = loadFleet().anchors[0]!;
    expect(() =>
      parseFleet({
        anchors: [{ ...valid, kind: " wallet" }],
      }),
    ).toThrow(/kind/);
    expect(() =>
      parseFleet({
        anchors: [{ ...valid, countries: ["nga"] }],
      }),
    ).toThrow(/countries/);
    expect(() =>
      parseFleet({
        anchors: [{ ...valid, added: "2026-02-30" }],
      }),
    ).toThrow(/added/);
  });
});
