import { describe, expect, it } from "vitest";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  createDefaultGate,
  createRegistryRouteResolver,
  wireCorridorDeps,
  executeCanary,
  DEFAULT_CANARY_MAX_AMOUNT,
  EXIT_REFUSED,
  EXIT_MISSING_ENV,
} from "../packages/cli/src/wire";

function makeCorridor(overrides: Record<string, unknown> = {}): Corridor {
  const r = parseCorridor({
    id: "test-canary-lane",
    source: { name: "Sender", asset: "USDC", endpoints: { home_domain: "sender.local" } },
    dest: {
      name: "Receiver",
      asset: "iso4217:USD",
      endpoints: {
        home_domain: "localhost:8080",
        transfer_server_sep31: "http://localhost:8080/sep31",
        quote_server: "http://localhost:8080/sep38",
        web_auth: "http://localhost:8080/auth",
        kyc_server: "http://localhost:8080/sep12",
        endpoints_verified_at: "2026-01-01",
      },
    },
    fx: { path: ["USD", "USDC", "USD"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "US", dest_jurisdiction: "US" },
    settlement: {
      network: "testnet",
      asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    },
    recovery: { max_retries: 2, timeout_seconds: 60, rollback: "refund_sender" },
    ...overrides,
  });
  if (!r.ok) throw new Error(`invalid corridor: ${r.error.message}`);
  return r.value;
}

describe("shared wiring module (wire.ts)", () => {
  const secret = Keypair.random().secret();

  it("wireCorridorDeps: wires Sep31Adapter, StellarSettlementSubmitter, the default gate and RegistryRouteResolver", () => {
    const c = makeCorridor();
    const wired = wireCorridorDeps(c, { signerSecret: secret });

    expect(wired.deps).toBeDefined();
    expect(wired.signer).toBeDefined();
    expect(wired.adapter).toBeDefined();
    expect(wired.submitter).toBeDefined();
    expect(wired.resolver).toBeDefined();
    expect(wired.gate).toBeDefined();
    expect(wired.store).toBeDefined();
    expect(wired.audit).toBeDefined();
    expect(wired.deps.gate).toBe(wired.gate);
    expect(wired.deps.resolver).toBe(wired.resolver);
    expect(wired.deps.submitter).toBe(wired.submitter);
  });

  it("createDefaultGate: creates CompositeGate with balanceCheck", async () => {
    const kp = Keypair.random();
    const mockInspector = {
      async account() {
        return {
          ok: true as const,
          value: {
            id: kp.publicKey(),
            subentry_count: 0,
            num_sponsoring: 0,
            num_sponsored: 0,
            balances: [
              {
                asset_type: "native",
                balance: "10.0000000",
                selling_liabilities: "0",
              },
              {
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                balance: "100.0000000",
                selling_liabilities: "0",
              },
            ],
          },
        };
      },
    };

    const gate = createDefaultGate(mockInspector, kp.publicKey());
    expect(gate).toBeDefined();
    const res = await gate.evaluate({
      intent: {
        idempotencyKey: "k",
        corridorId: "c",
        sender: { id: "s" },
        recipient: { id: "r" },
        sourceAmount: { asset: "USDC", amount: "5.00" },
      },
      corridor: makeCorridor(),
      quote: {
        id: "q",
        sourceAmount: { asset: "USDC", amount: "5.00" },
        destAmount: { asset: "USD", amount: "5.00" },
        price: "1.00",
        expiresAt: Date.now() + 60000,
        firm: true,
      },
      opened: {
        transactionId: "tx-1",
        instructions: { kind: "stellar_payment", to: "GDEP" },
        depositAddress: "GDEP",
      },
      now: Date.now(),
      attempt: 0,
    });

    expect(res.passed).toBe(true);
    expect(res.results[0].name).toBe("chain.balance");
  });

  it("createRegistryRouteResolver: allows local un-attested domains by default", async () => {
    const kp = Keypair.random();
    const c = makeCorridor();
    const resolver = createRegistryRouteResolver(c, {
      signer: { publicKey: kp.publicKey(), sign: async () => new Uint8Array(64) },
      network: "testnet",
    });

    const route = await resolver.resolve(
      {
        idempotencyKey: "k",
        corridorId: c.id,
        sender: { id: "s" },
        recipient: { id: "r" },
        sourceAmount: { asset: "USDC", amount: "1.00" },
      },
      c,
    );

    expect(route.receiving).toBeDefined();
    expect(route.trust).toBe("attested");
  });

  describe("executeCanary validation rules", () => {
    it("refuses unverified corridor", async () => {
      const c = makeCorridor({
        dest: {
          name: "Receiver",
          asset: "iso4217:USD",
          endpoints: {
            home_domain: "localhost:8080",
            transfer_server_sep31: "http://localhost:8080/sep31",
            // endpoints_verified_at omitted
          },
        },
      });

      const res = await executeCanary(c, { amount: "1.00" });
      expect(res.exitCode).toBe(EXIT_REFUSED);
      expect(res.error).toContain("liveness is unverified");
    });

    it("refuses mainnet corridor when --network public is missing", async () => {
      const c = makeCorridor({
        settlement: {
          network: "public",
          asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        },
      });

      const res = await executeCanary(c, { amount: "1.00" });
      expect(res.exitCode).toBe(EXIT_REFUSED);
      expect(res.error).toContain("mainnet requires --network public");
    });

    it("refuses over-cap amount against default cap", async () => {
      const c = makeCorridor();
      const res = await executeCanary(c, { amount: "100.00" });
      expect(res.exitCode).toBe(EXIT_REFUSED);
      expect(res.error).toContain(`amount exceeds canary cap ${DEFAULT_CANARY_MAX_AMOUNT}`);
    });

    it("refuses over-cap amount against proof.canary_max_amount", async () => {
      const c = makeCorridor({
        proof: {
          canary_max_amount: "5.00",
          canary_completed_at: "2026-09-01",
          stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          anchor_transaction_id: "canary-fixture-tx",
          amount: "1.00",
          max_age_days: 30,
        },
      });
      const res = await executeCanary(c, { amount: "5.01" });
      expect(res.exitCode).toBe(EXIT_REFUSED);
      expect(res.error).toContain("amount exceeds canary cap 5.00");
    });

    it("refuses when CORRIDOR_SIGNER_SECRET is missing", async () => {
      const orig = process.env.CORRIDOR_SIGNER_SECRET;
      delete process.env.CORRIDOR_SIGNER_SECRET;
      try {
        const c = makeCorridor();
        const res = await executeCanary(c, { amount: "1.00" });
        expect(res.exitCode).toBe(EXIT_MISSING_ENV);
        expect(res.error).toBe("missing CORRIDOR_SIGNER_SECRET");
      } finally {
        if (orig !== undefined) process.env.CORRIDOR_SIGNER_SECRET = orig;
      }
    });
  });
});
