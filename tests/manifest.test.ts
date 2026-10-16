import { describe, expect, it } from "vitest";
import { liveness, parseCorridor, LIVENESS_LABEL } from "@corridor/manifest";

const valid = {
  id: "t",
  source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
  dest: {
    protocol: "sep31",
    name: "D",
    asset: "iso4217:ARS",
    endpoints: {
      home_domain: "d.example",
      transfer_server_sep31: "https://d.example/sep31",
      quote_server: "https://d.example/sep38",
    },
  },
  fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
  compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
  settlement: { network: "public", asset_issuer: "GISSUER" },
  recovery: {},
};

const validProof = {
  canary_completed_at: "2026-09-20T12:00:00Z",
  stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  anchor_transaction_id: "anchor-tx-999",
  amount: "50.00",
};

describe("manifest", () => {
  it("parses a valid corridor and applies defaults", () => {
    const r = parseCorridor(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("t");
      expect(r.value.fx.quote_ttl_seconds).toBe(60); // default applied
      expect(r.value.settlement.bridge_asset).toBe("USDC"); // default applied
      expect(r.value.recovery.rollback).toBe("refund_sender"); // default applied
      expect(r.value.recovery.reconcile.external_stall_seconds).toBe(21_600);
    }
  });

  it("rejects an FX path with fewer than two hops", () => {
    const r = parseCorridor({ ...valid, fx: { path: ["ARS"], who_holds_risk: "sender" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MANIFEST_INVALID");
  });

  it("rejects a missing source", () => {
    const { source, ...rest } = valid;
    void source;
    const r = parseCorridor(rest);
    expect(r.ok).toBe(false);
  });

  it("accepts a SEP-31 destination and flags a missing SEP-31 endpoint as not runnable", () => {
    expect(parseCorridor(valid).ok).toBe(true);
    const legacy: { dest: { protocol?: string } } = structuredClone(valid);
    delete legacy.dest.protocol;
    const legacyResult = parseCorridor(legacy);
    expect(legacyResult.ok).toBe(true);
    if (legacyResult.ok) expect(legacyResult.value.dest.protocol).toBe("sep31");
    const bad: { dest: { endpoints: { transfer_server_sep31?: string } } } =
      structuredClone(valid);
    delete bad.dest.endpoints.transfer_server_sep31;
    const badResult = parseCorridor(bad);
    expect(badResult.ok).toBe(true);
    if (badResult.ok) expect(liveness(badResult.value).state).toBe("not-runnable");
  });

  it("accepts SEP-6 and rejects missing TRANSFER_SERVER", () => {
    const dest = {
      ...valid.dest,
      protocol: "sep6",
      endpoints: { home_domain: "d.example", transfer_server: "https://d.example/sep6" },
    };
    expect(parseCorridor({ ...valid, dest }).ok).toBe(true);
    expect(
      parseCorridor({ ...valid, dest: { ...dest, endpoints: { home_domain: "d.example" } } })
        .ok,
    ).toBe(false);
  });

  it("accepts a valid custom protocol and rejects malformed ids", () => {
    const dest = {
      ...valid.dest,
      protocol: "custom:acme",
      endpoints: { home_domain: "d.example", base_url: "https://api.d.example", extra: {} },
    };
    expect(parseCorridor({ ...valid, dest }).ok).toBe(true);
    expect(parseCorridor({ ...valid, dest: { ...dest, protocol: "custom:" } }).ok).toBe(false);
    expect(parseCorridor({ ...valid, dest: { ...dest, protocol: "sep24" } }).ok).toBe(false);
  });

  describe("source.protocol", () => {
    const withSource = (source: unknown) => parseCorridor({ ...valid, source });

    it("defaults an absent protocol to prefunded (existing manifests unchanged)", () => {
      const r = parseCorridor(valid);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.source.protocol).toBe("prefunded");
    });

    it("accepts prefunded with only name and asset", () => {
      const r = withSource({ name: "Treasury", asset: "USDC", protocol: "prefunded" });
      expect(r.ok).toBe(true);
    });

    it("accepts sep6 with transfer_server and rejects it without", () => {
      const base = { name: "S", asset: "USDC", protocol: "sep6" };
      const good = withSource({
        ...base,
        endpoints: { home_domain: "s.example", transfer_server: "https://s.example/sep6" },
      });
      expect(good.ok).toBe(true);
      const bad = withSource({ ...base, endpoints: { home_domain: "s.example" } });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.code).toBe("MANIFEST_INVALID");
    });

    it("accepts sep24 with transfer_server_sep24 + web_auth and rejects a missing one", () => {
      const base = { name: "S", asset: "USDC", protocol: "sep24" };
      const good = withSource({
        ...base,
        endpoints: {
          home_domain: "s.example",
          transfer_server_sep24: "https://s.example/sep24",
          web_auth: "https://s.example/auth",
        },
      });
      expect(good.ok).toBe(true);
      const noAuth = withSource({
        ...base,
        endpoints: {
          home_domain: "s.example",
          transfer_server_sep24: "https://s.example/sep24",
        },
      });
      expect(noAuth.ok).toBe(false);
    });

    it("accepts custom:<id> with base_url and rejects unknown protocols", () => {
      const good = withSource({
        name: "S",
        asset: "USDC",
        protocol: "custom:acme",
        endpoints: { home_domain: "s.example", base_url: "https://s.example/api" },
      });
      expect(good.ok).toBe(true);
      const noUrl = withSource({
        name: "S",
        asset: "USDC",
        protocol: "custom:acme",
        endpoints: { home_domain: "s.example" },
      });
      expect(noUrl.ok).toBe(false);
      const unknown = withSource({ name: "S", asset: "USDC", protocol: "sep99" });
      expect(unknown.ok).toBe(false);
    });
  });

  describe("proof schema", () => {
    it("parses valid proof and applies default max_age_days = 30", () => {
      const r = parseCorridor({ ...valid, proof: validProof });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.proof?.canary_completed_at).toBe("2026-09-20T12:00:00Z");
        expect(r.value.proof?.max_age_days).toBe(30);
        expect(r.value.proof?.amount).toBe("50.00");
      }
    });

    it("rejects malformed stellar_tx_hash", () => {
      const r = parseCorridor({
        ...valid,
        proof: { ...validProof, stellar_tx_hash: "invalid-hash-too-short" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("MANIFEST_INVALID");
        expect(r.error.message).toContain("stellar_tx_hash");
      }
    });

    it("rejects malformed canary_completed_at date", () => {
      const r = parseCorridor({
        ...valid,
        proof: { ...validProof, canary_completed_at: "not-an-iso-date" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("MANIFEST_INVALID");
        expect(r.error.message).toContain("canary_completed_at");
      }
    });

    it("rejects a calendar date that does not exist", () => {
      const r = parseCorridor({
        ...valid,
        proof: { ...validProof, canary_completed_at: "2026-02-30" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("canary_completed_at");
    });

    it("accepts 29 February in a leap year and rejects it otherwise", () => {
      expect(
        parseCorridor({
          ...valid,
          proof: { ...validProof, canary_completed_at: "2028-02-29" },
        }).ok,
      ).toBe(true);
      expect(
        parseCorridor({
          ...valid,
          proof: { ...validProof, canary_completed_at: "2027-02-29" },
        }).ok,
      ).toBe(false);
    });

    it("rejects malformed proof amount", () => {
      const r = parseCorridor({
        ...valid,
        proof: { ...validProof, amount: "not-a-number" },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("MANIFEST_INVALID");
        expect(r.error.message).toContain("amount");
      }
    });
  });

  describe("liveness tiers", () => {
    const verifiedCorridor = {
      ...valid,
      dest: {
        ...valid.dest,
        endpoints: {
          ...valid.dest.endpoints,
          endpoints_verified_at: "2026-09-20",
        },
      },
    };

    it("has LIVENESS_LABEL defined for proven", () => {
      expect(LIVENESS_LABEL.proven).toBe("proven");
      expect(LIVENESS_LABEL.verified).toBe("verified");
      expect(LIVENESS_LABEL.unverified).toBe("unverified");
      expect(LIVENESS_LABEL["not-runnable"]).toBe("not runnable");
    });

    it("reports proven when verified and fresh proof is present", () => {
      const parsed = parseCorridor({
        ...verifiedCorridor,
        proof: {
          ...validProof,
          canary_completed_at: "2026-09-20T00:00:00Z",
          max_age_days: 30,
        },
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const now = new Date("2026-09-25T00:00:00Z"); // 5 days old < 30 days
        const live = liveness(parsed.value, now);
        expect(live.state).toBe("proven");
        expect(live.runnable).toBe(true);
        expect(live.proof?.anchor_transaction_id).toBe("anchor-tx-999");
      }
    });

    it("reports verified + warning when proof is stale", () => {
      const parsed = parseCorridor({
        ...verifiedCorridor,
        proof: {
          ...validProof,
          canary_completed_at: "2026-08-01T00:00:00Z",
          max_age_days: 30,
        },
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const now = new Date("2026-09-25T00:00:00Z"); // 55 days old > 30 days
        const live = liveness(parsed.value, now);
        expect(live.state).toBe("verified");
        expect(live.runnable).toBe(true);
        expect(live.warnings.some((w) => w.includes("proof is stale"))).toBe(true);
      }
    });

    it("does not call a future-dated proof 'stale', and does not honour it", () => {
      const parsed = parseCorridor({
        ...verifiedCorridor,
        proof: { ...validProof, canary_completed_at: "2026-12-01T00:00:00Z" },
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const live = liveness(parsed.value, new Date("2026-09-25T00:00:00Z"));
        expect(live.state).toBe("verified");
        expect(live.warnings.some((w) => w.includes("in the future"))).toBe(true);
        expect(live.warnings.some((w) => w.includes("stale"))).toBe(false);
      }
    });

    it("reports unverified when endpoints_verified_at is missing even with proof", () => {
      const parsed = parseCorridor({
        ...valid, // no endpoints_verified_at
        proof: validProof,
      });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const now = new Date("2026-09-25T00:00:00Z");
        const live = liveness(parsed.value, now);
        expect(live.state).toBe("unverified");
        expect(live.runnable).toBe(false);
        expect(live.warnings.some((w) => w.includes("UNVERIFIED"))).toBe(true);
      }
    });

    it("reports not-runnable when missing transfer_server_sep31 even with proof", () => {
      const noTransfer = {
        ...verifiedCorridor,
        dest: {
          ...verifiedCorridor.dest,
          endpoints: {
            home_domain: "d.example",
            endpoints_verified_at: "2026-09-20",
          },
        },
        proof: validProof,
      };
      const parsed = parseCorridor(noTransfer);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const live = liveness(parsed.value);
        expect(live.state).toBe("not-runnable");
        expect(live.runnable).toBe(false);
      }
    });
  });
});

describe("recovery.reconcile", () => {
  it("is optional and leaves the fields unset by default", () => {
    const r = parseCorridor(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.recovery.reconcile.poll_seconds).toBeUndefined();
      expect(r.value.recovery.reconcile.stall_polls).toBeUndefined();
    }
  });

  it("parses poll_seconds and stall_polls (0 allowed to disable)", () => {
    const r = parseCorridor({
      ...valid,
      recovery: { reconcile: { poll_seconds: 5, stall_polls: 0 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.recovery.reconcile).toMatchObject({ poll_seconds: 5, stall_polls: 0 });
    const partial = parseCorridor({ ...valid, recovery: { reconcile: { stall_polls: 4 } } });
    expect(partial.ok && partial.value.recovery.reconcile.poll_seconds).toBeUndefined();
  });

  it("rejects non-positive poll_seconds and negative stall_polls", () => {
    for (const reconcile of [
      { poll_seconds: 0 },
      { poll_seconds: 1.5 },
      { stall_polls: -1 },
    ]) {
      expect(parseCorridor({ ...valid, recovery: { reconcile } }).ok).toBe(false);
    }
  });

  it("warns when poll_seconds x stall_polls can never fire before the timeout", () => {
    const mk = (reconcile: object) => {
      const r = parseCorridor({ ...valid, recovery: { timeout_seconds: 60, reconcile } });
      if (!r.ok) throw new Error("invalid");
      return liveness(r.value).warnings.filter((w) =>
        w.includes("stall check can never fire"),
      );
    };
    expect(mk({ poll_seconds: 10, stall_polls: 6 })).toHaveLength(1);
    expect(mk({ poll_seconds: 12, stall_polls: 5 })).toHaveLength(1);
    expect(mk({ poll_seconds: 10, stall_polls: 4 })).toHaveLength(0);
    expect(mk({ poll_seconds: 10, stall_polls: 0 })).toHaveLength(0);
  });

  // fx.min_quote_remaining_seconds (#152): the settle+confirm margin the
  // quote.window gate check enforces.
  it("defaults min_quote_remaining_seconds to 45", () => {
    const r = parseCorridor(valid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fx.min_quote_remaining_seconds).toBe(45);
  });

  it("accepts a margin smaller than the quote TTL", () => {
    const r = parseCorridor({
      ...valid,
      fx: { ...valid.fx, quote_ttl_seconds: 120, min_quote_remaining_seconds: 90 },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.fx.min_quote_remaining_seconds).toBe(90);
  });

  it("rejects a margin at or above the quote TTL", () => {
    // margin == ttl refuses every firm quote the moment it is minted — a
    // corridor that can never settle is a misconfiguration, not caution.
    for (const min_quote_remaining_seconds of [60, 61]) {
      const r = parseCorridor({
        ...valid,
        fx: { ...valid.fx, quote_ttl_seconds: 60, min_quote_remaining_seconds },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("MANIFEST_INVALID");
        expect(r.error.message).toContain("min_quote_remaining_seconds");
      }
    }
  });

  it("rejects a non-positive or fractional margin", () => {
    for (const bad of [0, -5, 1.5]) {
      const r = parseCorridor({
        ...valid,
        fx: { ...valid.fx, min_quote_remaining_seconds: bad },
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe("limits", () => {
  it("accepts valid min_amount without max_amount", () => {
    const r = parseCorridor({ ...valid, limits: { min_amount: "10.50" } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.limits?.min_amount).toBe("10.50");
    }
  });

  it("rejects malformed min_amount", () => {
    const r = parseCorridor({ ...valid, limits: { min_amount: "not-a-number" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("MANIFEST_INVALID");
      expect(r.error.message).toContain("limits");
    }
  });

  it("rejects min_amount > max_amount", () => {
    const r = parseCorridor({
      ...valid,
      limits: { min_amount: "100.00", max_amount: "50.00" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("MANIFEST_INVALID");
      expect(r.error.message).toContain("min_amount");
    }
  });

  it("accepts min_amount == max_amount", () => {
    const r = parseCorridor({
      ...valid,
      limits: { min_amount: "50.00", max_amount: "50.00" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.limits?.min_amount).toBe("50.00");
      expect(r.value.limits?.max_amount).toBe("50.00");
    }
  });

  it("accepts min_amount < max_amount", () => {
    const r = parseCorridor({
      ...valid,
      limits: { min_amount: "10.00", max_amount: "50.00" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.limits?.min_amount).toBe("10.00");
      expect(r.value.limits?.max_amount).toBe("50.00");
    }
  });

  describe("legacy flat SEP-31 dest (no protocol)", () => {
    const { protocol: _p, ...legacyDest } = valid.dest;
    const legacy = { ...valid, dest: legacyDest };

    it("parses as sep31 and returns a deprecation warning", () => {
      const r = parseCorridor(legacy);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.dest.protocol).toBe("sep31");
        expect(r.warnings.some((w) => w.includes("sep31") && w.includes("deprecated"))).toBe(
          true,
        );
      }
    });

    it("emits no warning when protocol is explicit", () => {
      const r = parseCorridor(valid);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.warnings).toEqual([]);
    });

    it("rejects transfer_server without protocol, telling the author to set sep6", () => {
      const r = parseCorridor({
        ...valid,
        dest: {
          ...legacyDest,
          endpoints: { home_domain: "d.example", transfer_server: "https://d.example/sep6" },
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("protocol: sep6");
    });

    it("rejects base_url without protocol, telling the author to set custom:<name>", () => {
      const r = parseCorridor({
        ...valid,
        dest: {
          ...legacyDest,
          endpoints: { home_domain: "d.example", base_url: "https://d.example/api" },
        },
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("custom:<name>");
    });
  });
});
