import { describe, expect, it } from "vitest";
import { checkCompatibility } from "@corridor/engine";
import { StellarPaymentStrategy, createMockSubmitter } from "@corridor/engine";
import type { AdapterCapabilities } from "@corridor/adapter-kit";
import { parseCorridor } from "@corridor/manifest";

function testCorridor(overrides: Record<string, unknown> = {}) {
  const r = parseCorridor({
    id: "test-compat-lane",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: {
      path: ["ARS", "USDC", "ARS"],
      quote_source: "sep38",
      who_holds_risk: "receiving_anchor",
      quote_ttl_seconds: 60,
      min_quote_remaining_seconds: 45,
    },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "testnet", asset_issuer: "GISSUER" },
    recovery: { max_retries: 2 },
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
    ...overrides,
  });
  if (!r.ok) throw new Error(`invalid fixture: ${r.error.message}`);
  return r.value;
}

const defaultStrategies = [new StellarPaymentStrategy(createMockSubmitter())];

const validCaps: AdapterCapabilities = {
  protocol: "sep31",
  quotes: ["sep38_firm"],
  kyc: "sep12",
  settlement: ["stellar_payment"],
  refunds: "report_only",
  callbacks: false,
};

describe("checkCompatibility", () => {
  it("passes when corridor and adapter capabilities match", () => {
    const res = checkCompatibility(testCorridor(), validCaps, defaultStrategies);
    expect(res.ok).toBe(true);
  });

  it("fails when corridor requires sep38 but adapter quotes is ['none']", () => {
    const caps: AdapterCapabilities = {
      ...validCaps,
      quotes: ["none"],
    };
    const res = checkCompatibility(testCorridor(), caps, defaultStrategies);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("CAPABILITY_MISMATCH");
      expect(res.error.message).toContain('requires fx.quote_source "sep38"');
    }
  });

  it("passes when corridor requires sep38 and adapter reports sep38_indicative", () => {
    const caps: AdapterCapabilities = {
      ...validCaps,
      quotes: ["sep38_indicative"],
    };
    const res = checkCompatibility(testCorridor(), caps, defaultStrategies);
    expect(res.ok).toBe(true);
  });

  it("ignores caps.kyc when the manifest declares no compliance.method", () => {
    const res = checkCompatibility(
      testCorridor(),
      { ...validCaps, kyc: "none" },
      defaultStrategies,
    );
    expect(res.ok).toBe(true);
  });

  it("fails closed when an explicit compliance.method disagrees with caps.kyc", () => {
    // A manifest that says "none" must not switch off KYC the adapter enforces.
    const corridor = testCorridor({
      compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR", method: "none" },
    });
    const res = checkCompatibility(corridor, validCaps, defaultStrategies);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("CAPABILITY_MISMATCH");
      expect(res.error.message).toContain('compliance.method "none"');
    }
    const agreed = checkCompatibility(
      corridor,
      { ...validCaps, kyc: "none" },
      defaultStrategies,
    );
    expect(agreed.ok).toBe(true);
  });

  it("fails when adapter settlement is empty", () => {
    const caps: AdapterCapabilities = {
      ...validCaps,
      settlement: [],
    };
    const res = checkCompatibility(testCorridor(), caps, defaultStrategies);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("CAPABILITY_MISMATCH");
      expect(res.error.message).toContain("no settlement capabilities");
    }
  });

  it("fails when an adapter settlement kind is not covered by any strategy", () => {
    const caps: AdapterCapabilities = {
      ...validCaps,
      settlement: ["stellar_payment", "claimable_balance"],
    };
    const res = checkCompatibility(testCorridor(), caps, defaultStrategies);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("CAPABILITY_MISMATCH");
      expect(res.error.message).toContain("claimable_balance");
    }
  });
});
