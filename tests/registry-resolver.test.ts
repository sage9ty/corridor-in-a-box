// RegistryRouteResolver is a GATE. Almost everything worth testing is a case
// where it must refuse — a gate that only gets tested on its happy path is a
// gate nobody has actually checked.

import { describe, expect, it } from "vitest";
import { loadCorridor, parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import {
  RegistryRouteResolver,
  UnattestedAnchorError,
  type AttestationSource,
  type AttestationSourceLike,
  type AttestedProtocol,
  type LegacyAttestationSource,
} from "@corridor/router";
import type { PaymentIntent } from "@corridor/types";

const loaded = loadCorridor("corridors/reference.corridor.yaml");
if (!loaded.ok) throw new Error("fixture manifest failed to load");
const CORRIDOR: Corridor = loaded.value;
/** reference.corridor.yaml's dest home_domain. */
const DOMAIN = CORRIDOR.dest.endpoints.home_domain;

const INTENT: PaymentIntent = {
  idempotencyKey: "k",
  corridorId: CORRIDOR.id,
  sender: { id: "s" },
  recipient: { id: "r", sep12Id: "cust-1" },
  sourceAmount: { asset: "USDC", amount: "100.00" },
};

/** Build a corridor with the given destination, in memory. */
function corridorWith(dest: Record<string, unknown>): Corridor {
  const parsed = parseCorridor({
    id: "fixture",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: { name: "D", asset: "iso4217:USD", ...dest },
    fx: { path: ["USD", "USDC", "USD"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "US" },
    settlement: { network: "testnet", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!parsed.ok) throw new Error("fixture corridor failed to parse");
  return parsed.value;
}

const SEP6_CORRIDOR = corridorWith({
  protocol: "sep6",
  endpoints: { home_domain: "sep6.example", transfer_server: "https://sep6.example/sep6" },
});

const CUSTOM_CORRIDOR = corridorWith({
  protocol: "custom:http-stub",
  endpoints: { home_domain: "custom.example", base_url: "https://custom.example/api" },
});
const CUSTOM_DOMAIN = CUSTOM_CORRIDOR.dest.endpoints.home_domain;

/** An attestation source with whatever answers a test needs.
 *
 *  This is the OLD shape — a source that can only answer the SEP-31 question —
 *  so the cases below also prove the compatibility adapter keeps working. */
function source(over: Partial<LegacyAttestationSource> = {}): LegacyAttestationSource {
  return {
    servesSep31: async () => true,
    staleness: async () => 0,
    tomlHash: async () => "0".repeat(64),
    ...over,
  };
}

/** A protocol-aware attestation source: it answers per protocol. */
function protocolSource(over: Partial<AttestationSource> = {}): AttestationSource {
  return {
    serves: async (_domain: string, protocol: AttestedProtocol) => protocol === "sep31",
    staleness: async () => 0,
    tomlHash: async () => "0".repeat(64),
    ...over,
  };
}

function resolver(registry: AttestationSourceLike, opts = {}) {
  return new RegistryRouteResolver({
    registry,
    adapterFor: () => createMockAdapter(),
    ...opts,
  });
}

describe("RegistryRouteResolver", () => {
  it("routes through an anchor attested as working and fresh", async () => {
    const decision = await resolver(source()).resolve(INTENT, CORRIDOR);
    expect(decision.receiving).toBeDefined();
  });

  // The central case: advertising SEP-31 is not the same as serving it, and the
  // resolver takes its answer from the probe result, not the manifest.
  it("refuses an anchor that is not attested as serving SEP-31", async () => {
    const r = resolver(source({ servesSep31: async () => false }));
    await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
    await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(
      /not attested as serving SEP-31/,
    );
  });

  it("refuses an attestation older than the freshness limit", async () => {
    const r = resolver(source({ staleness: async () => 200_000 }), {
      maxStalenessLedgers: 100_000,
    });
    await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(
      /older than the 100000 ledger limit/,
    );
  });

  it("accepts an attestation exactly at the freshness limit", async () => {
    const r = resolver(source({ staleness: async () => 100_000 }), {
      maxStalenessLedgers: 100_000,
    });
    await expect(r.resolve(INTENT, CORRIDOR)).resolves.toBeDefined();
  });

  // "We cannot tell" must never resolve to "go ahead". This is the difference
  // between a gate and a formality.
  it("fails CLOSED when the registry is unreachable", async () => {
    const r = resolver(
      source({
        servesSep31: async () => {
          throw new Error("rpc timeout");
        },
      }),
    );
    await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
    await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(/registry lookup failed/);
  });

  it("fails closed when the staleness lookup is the one that breaks", async () => {
    const r = resolver(
      source({
        staleness: async () => {
          throw new Error("rpc timeout");
        },
      }),
    );
    await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
  });

  it("names the domain it refused, so an operator knows what to fix", async () => {
    const r = resolver(source({ servesSep31: async () => false }));
    await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(
      new RegExp(DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  describe("the protocol the corridor declares", () => {
    // The gate asks the registry about the protocol the lane actually uses.
    // Asking about SEP-31 for a SEP-6 corridor would refuse every SEP-6 lane.
    it("asks the registry about the corridor's protocol, not a fixed one", async () => {
      const asked: string[] = [];
      const r = resolver(
        protocolSource({
          serves: async (_domain: string, protocol: AttestedProtocol) => {
            asked.push(protocol);
            return true;
          },
        }),
      );
      const decision = await r.resolve(INTENT, SEP6_CORRIDOR);
      expect(decision.receiving).toBeDefined();
      expect(asked).toEqual(["sep6"]);
    });

    it("routes a SEP-6 corridor through an anchor attested as serving SEP-6", async () => {
      const r = resolver(
        protocolSource({
          serves: async (_domain: string, protocol: AttestedProtocol) => protocol === "sep6",
        }),
      );
      await expect(r.resolve(INTENT, SEP6_CORRIDOR)).resolves.toBeDefined();
    });

    it("refuses a SEP-6 corridor when only SEP-31 is attested", async () => {
      const r = resolver(
        protocolSource({
          serves: async (_domain: string, protocol: AttestedProtocol) => protocol === "sep31",
        }),
      );
      await expect(r.resolve(INTENT, SEP6_CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
      await expect(r.resolve(INTENT, SEP6_CORRIDOR)).rejects.toThrow(
        /not attested as serving SEP-6/,
      );
    });

    // A source that can only speak about SEP-31 must not be able to wave a
    // SEP-6 lane through by saying "yes" to the only question it can answer.
    it("does not let a SEP-31-only source wave a SEP-6 lane through", async () => {
      const r = resolver(source({ servesSep31: async () => true }));
      await expect(r.resolve(INTENT, SEP6_CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
      await expect(r.resolve(INTENT, SEP6_CORRIDOR)).rejects.toThrow(
        /not attested as serving SEP-6/,
      );
    });

    // A bespoke lane has no on-chain probe at all, so there is no evidence to
    // gather: the gate refuses and says which protocol is the problem.
    it("fails closed for a bespoke protocol and names it", async () => {
      const r = resolver(protocolSource());
      await expect(r.resolve(INTENT, CUSTOM_CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
      await expect(r.resolve(INTENT, CUSTOM_CORRIDOR)).rejects.toThrow(/custom:http-stub/);
      await expect(r.resolve(INTENT, CUSTOM_CORRIDOR)).rejects.toThrow(
        /no on-chain attestation probe/,
      );
    });

    it("lets a bespoke lane through only when the operator allowlists it", async () => {
      const r = resolver(protocolSource(), { allowUnattestedDomains: [CUSTOM_DOMAIN] });
      await expect(r.resolve(INTENT, CUSTOM_CORRIDOR)).resolves.toBeDefined();
    });
  });

  describe("allowUnattestedDomains", () => {
    it("lets a named domain through without consulting the registry at all", async () => {
      let consulted = false;
      const r = resolver(
        source({
          servesSep31: async () => {
            consulted = true;
            return false;
          },
        }),
        { allowUnattestedDomains: [DOMAIN] },
      );
      await expect(r.resolve(INTENT, CORRIDOR)).resolves.toBeDefined();
      expect(consulted).toBe(false);
    });

    it("only exempts the domains actually listed", async () => {
      const r = resolver(source({ servesSep31: async () => false }), {
        allowUnattestedDomains: ["some-other.example"],
      });
      await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
    });

    it("defaults to exempting nothing", async () => {
      const r = resolver(source({ servesSep31: async () => false }));
      await expect(r.resolve(INTENT, CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
    });

    it("does not exempt a SEP-6 domain by accident", async () => {
      const r = resolver(source({ servesSep31: async () => true }), {
        allowUnattestedDomains: [DOMAIN],
      });
      await expect(r.resolve(INTENT, SEP6_CORRIDOR)).rejects.toThrow(UnattestedAnchorError);
    });
  });
});
