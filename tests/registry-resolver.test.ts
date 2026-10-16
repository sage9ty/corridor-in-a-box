// RegistryRouteResolver is a GATE. Almost everything worth testing is a case
// where it must refuse — a gate that only gets tested on its happy path is a
// gate nobody has actually checked.

import { describe, expect, it } from "vitest";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import {
  RegistryRouteResolver,
  UnattestedAnchorError,
  type AttestationSource,
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

/** An attestation source with whatever answers a test needs. */
function source(over: Partial<AttestationSource> = {}): AttestationSource {
  return {
    servesSep31: async () => true,
    staleness: async () => 0,
    tomlHash: async () => "0".repeat(64),
    ...over,
  };
}

function resolver(registry: AttestationSource, opts = {}) {
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
  });
});
