import { describe, expect, it, vi } from "vitest";
import { parseCorridor, hashCorridor, type Corridor } from "@corridor/manifest";
import {
  createMockAdapter,
  createMockSourceAdapter,
  type OpenTransaction,
} from "@corridor/adapter-kit";
import {
  StaticRouteResolver,
  UnattestedAnchorError,
  type RouteResolver,
} from "@corridor/router";
import { amountRangeCheck } from "@corridor/sep31";
import {
  defaultSep31Gate,
  InMemoryAuditLog,
  InMemoryCorridorHealthStore,
  InMemoryIdempotencyStore,
  InMemoryMetrics,
  hasRequestedRefund,
  canTransition,
  createMockSubmitter,
  StellarPaymentStrategy,
  execute,
  reconcileUntil,
  type CorridorState,
  type EngineDeps,
  type PreSettleGate,
  type SettlementSubmitter,
  type SettlementStrategy,
  type StoredRun,
} from "@corridor/engine";
import type { TransactionStatus } from "@corridor/adapter-kit";
import { fail, ok, type Outcome, type PaymentIntent, settlementId } from "@corridor/types";
import { StellarPathPaymentStrategy, StellarSettlementSubmitter } from "@corridor/stellar";
import { Account, Keypair, type Horizon, type Transaction } from "@stellar/stellar-sdk";

function corridor(sourceProtocol: "prefunded" | "sep6" = "prefunded"): Corridor {
  const r = parseCorridor({
    id: "test",
    source: {
      name: "S",
      asset: "USDC",
      protocol: sourceProtocol,
      endpoints: {
        home_domain: "s.example",
        ...(sourceProtocol === "sep6" && { transfer_server: "https://s.example/sep6" }),
      },
    },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: { max_retries: 2 },
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function intent(key = "k1"): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

function deps(adapterOpts = {}, trustManifestWithoutAttestation = true): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    trustManifestWithoutAttestation,
    unsafeSkipPreSettleGate: true,
  };
}

describe("engine.execute", () => {
  it("funds a non-prefunded corridor through its source adapter before settling", async () => {
    const nonPrefunded = corridor("sep6");
    const source = createMockSourceAdapter();
    const receiving = createMockAdapter();
    const r = await execute(intent("source-funded"), nonPrefunded, {
      ...deps(),
      resolver: {
        async resolve() {
          return { receiving, sending: source, trust: "manifest" as const };
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.trail).toContain("funding");
      expect(r.value.trail).toContain("funded");
      expect(r.value.trail.indexOf("funding")).toBeLessThan(r.value.trail.indexOf("settling"));
      expect(r.value.trail.indexOf("funded")).toBeLessThan(r.value.trail.indexOf("settling"));
    }
  });

  it("walks a payment to completed", async () => {
    const r = await execute(intent(), corridor(), deps());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.stellarTxHash).toBeTruthy();
      expect(r.value.trail).toEqual([
        "created",
        "quoted",
        "compliant",
        "opened",
        "verifying",
        "settling",
        "settled",
        "reconciled",
        "completed",
      ]);
    }
  });

  it("fails closed on an expired quote", async () => {
    const r = await execute(intent(), corridor(), deps({ expireQuoteImmediately: true }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_EXPIRED");
  });

  it("does not settle against a quote that expired during a retry", async () => {
    // The quote was VALID when execute() started (unlike the test above) —
    // it expires only partway through the settle/retry loop, e.g. because a
    // slow anchor or a couple of retries ran out the clock. Without a fresh
    // expiry check inside the loop, the second settle attempt would submit
    // at a stale, no-longer-honoured rate.
    let clock = Date.now();
    const now = () => clock;
    // Stands in for a retry backoff that, combined with real-world latency,
    // runs well past the quote's ~60s validity window.
    const sleep = async (ms: number) => {
      clock += ms + 65_000;
    };

    let submitCalls = 0;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalls++;
        return fail("SETTLEMENT_FAILED", "simulated transient failure", { retryable: true });
      },
      async refund() {
        return fail("SETTLEMENT_FAILED", "not reached", { retryable: false });
      },
    };

    const r = await execute(intent(), corridor(), {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      now,
      sleep,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUOTE_EXPIRED");
    // Exactly one settle attempt: the retry loop's fresh expiry check catches
    // the stale quote before ever calling submit() a second time.
    expect(submitCalls).toBe(1);
  });

  it("a public-network corridor with manifest trust and no opt-in ends failed before settling", async () => {
    let submitCalled = false;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalled = true;
        return ok({ kind: "stellar", stellarTxHash: "hash", ledger: 1 });
      },
      async refund() {
        return ok({ kind: "stellar", stellarTxHash: "refund-hash", ledger: 2 });
      },
    };
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: store,
      audit,
      unsafeSkipPreSettleGate: true,
      // No trustManifestWithoutAttestation on deps or opts
    };

    const c = corridor(); // network: "public"
    const i = intent("manifest-refuse-1");
    const r = await execute(i, c, d);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("MANIFEST_INVALID");
      expect(r.error.message).toContain("refusing manifest route trust on public network");
    }

    const stored = await store.get(i.idempotencyKey);
    expect(stored?.state).toBe("failed");
    expect(submitCalled).toBe(false);

    const trail = audit.entries.map((e) => e.to);
    expect(trail).toContain("failed");
    expect(trail).not.toContain("settling");
    expect(trail).not.toContain("settled");
    expect(trail).not.toContain("completed");
  });

  it("fails closed when KYC is rejected", async () => {
    const r = await execute(intent(), corridor(), deps({ kyc: "rejected" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("KYC_REJECTED");
  });

  it("is idempotent: a second in-flight run with the same key conflicts", async () => {
    const sharedDeps = deps();
    const c = corridor();
    const a = await execute(intent("dup"), c, sharedDeps);
    expect(a.ok).toBe(true);
    // completed run with same key returns idempotently rather than re-settling
    const b = await execute(intent("dup"), c, sharedDeps);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value.state).toBe("completed");
  });

  it("rejects a malformed source amount before touching the chain", async () => {
    const bad: PaymentIntent = {
      ...intent(),
      sourceAmount: { asset: "USDC", amount: "1,000" },
    };
    const r = await execute(bad, corridor(), deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AMOUNT_INVALID");
  });

  it("reuses an existing on-chain settlement without calling submit()", async () => {
    let submitCalls = 0;
    const existingRef = {
      kind: "stellar" as const,
      stellarTxHash: "existing-tx-hash-123",
      ledger: 777,
    };
    const submitter = createMockSubmitter({ existingRef });
    const originalSubmit = submitter.submit;
    submitter.submit = async (req) => {
      submitCalls++;
      return originalSubmit(req);
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent("existing-settle"), corridor(), d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.stellarTxHash).toBe("existing-tx-hash-123");
    }
    expect(submitCalls).toBe(0);
  });
});

describe("engine pre-settle gate", () => {
  it("terminates in failed with check code and 0 submit calls when gate check fails", async () => {
    let submitCalls = 0;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalls++;
        return ok({ kind: "stellar", stellarTxHash: "tx-123", ledger: 100 });
      },
      async refund() {
        return ok({ kind: "stellar", stellarTxHash: "refund-123", ledger: 101 });
      },
    };

    const metrics = new InMemoryMetrics();
    const failingGate: PreSettleGate = {
      async evaluate() {
        return {
          passed: false,
          results: [
            {
              name: "chain.balance",
              passed: false,
              code: "PRESETTLE_INSUFFICIENT_FUNDS",
              detail: "insufficient bridge asset balance",
              durationMs: 5,
            },
          ],
        };
      },
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      gate: failingGate,
      idempotency: new InMemoryIdempotencyStore(),
      metrics,
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent(), corridor(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(r.error.message).toBe("insufficient bridge asset balance");
    }
    expect(submitCalls).toBe(0);
    const gateCounters = metrics.counters.filter((c) => c.name === "corridor.gate.check");
    expect(gateCounters).toHaveLength(1);
    expect(gateCounters[0].tags).toEqual({ name: "chain.balance", passed: "false" });
  });

  it("refuses with PRESETTLE_AMOUNT_OUT_OF_RANGE and 0 submit calls when the quoted amount exceeds the anchor /info max", async () => {
    let submitCalls = 0;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalls++;
        return ok({ kind: "stellar", stellarTxHash: "tx-123", ledger: 100 });
      },
      async refund() {
        return ok({ kind: "stellar", stellarTxHash: "refund-123", ledger: 101 });
      },
    };
    const c = corridor();
    let infoFetches = 0;
    const infoAdapter = {
      async getInfo() {
        infoFetches++;
        return ok({ receive: { [c.settlement.bridge_asset]: { maxAmount: "1" } } });
      },
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      gate: defaultSep31Gate({ checks: [amountRangeCheck(infoAdapter)] }),
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent("range-max"), c, d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PRESETTLE_AMOUNT_OUT_OF_RANGE");
      expect(r.error.message).toContain("above maximum 1");
    }
    expect(submitCalls).toBe(0);
    expect(infoFetches).toBe(1);
  });

  it("re-evaluates gate after retrying (attempt 1 fails submit, attempt 2 fails gate)", async () => {
    let submitCalls = 0;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalls++;
        return fail("SETTLEMENT_FAILED", "transient network error", { retryable: true });
      },
      async refund() {
        return ok({ kind: "stellar", stellarTxHash: "refund-123", ledger: 101 });
      },
    };

    const evaluatedAttempts: number[] = [];
    const gate: PreSettleGate = {
      async evaluate(ctx) {
        evaluatedAttempts.push(ctx.attempt);
        if (ctx.attempt === 0) {
          return {
            passed: true,
            results: [
              {
                name: "chain.balance",
                passed: true,
                detail: "sufficient",
                durationMs: 2,
              },
            ],
          };
        }
        return {
          passed: false,
          results: [
            {
              name: "chain.balance",
              passed: false,
              code: "PRESETTLE_INSUFFICIENT_FUNDS",
              detail: "balance depleted on retry",
              durationMs: 2,
            },
          ],
        };
      },
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      gate,
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent(), corridorWith({ max_retries: 2 }), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(r.error.message).toBe("balance depleted on retry");
    }
    expect(evaluatedAttempts).toEqual([0, 1]);
    expect(submitCalls).toBe(1); // attempt 0 called submit; attempt 1 died at gate before submit
  });

  it("ends failed without entering settling when gate evaluation throws", async () => {
    let submitCalled = false;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalled = true;
        return ok({ kind: "stellar", stellarTxHash: "tx-123", ledger: 100 });
      },
      async refund() {
        return ok({ kind: "stellar", stellarTxHash: "refund-123", ledger: 101 });
      },
    };

    const audit = new InMemoryAuditLog();
    const throwingGate: PreSettleGate = {
      async evaluate() {
        throw new Error("unexpected gate crash");
      },
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      gate: throwingGate,
      idempotency: new InMemoryIdempotencyStore(),
      audit,
      trustManifestWithoutAttestation: true,
    };

    const r = await execute(intent(), corridor(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_FAILED");
      expect(r.error.message).toContain("unexpected gate crash");
    }
    expect(submitCalled).toBe(false);

    const states = audit.entries.map((e) => e.to);
    expect(states).toContain("verifying");
    expect(states).toContain("failed");
    expect(states).not.toContain("settling");
  });

  it("rejects an over-cap unproven payment before claiming the idempotency key", async () => {
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const c = { ...corridor(), proof: undefined };
    const i = {
      ...intent("unproven-over-cap"),
      sourceAmount: { asset: "USDC", amount: "10.01" },
    };

    const r = await execute(i, c, { ...deps(), idempotency: store, audit });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CORRIDOR_UNPROVEN");
    expect(await store.get(i.idempotencyKey)).toBeUndefined();
    expect(audit.details[0]).toMatchObject({
      event: "verifying",
      detail: { liveness: "verified", effectiveCap: "10" },
    });
  });

  it("allows an unproven payment at the canary cap", async () => {
    const c = { ...corridor(), proof: undefined };
    const i = { ...intent("unproven-at-cap"), sourceAmount: { asset: "USDC", amount: "10" } };

    const r = await execute(i, c, deps());

    expect(r.ok).toBe(true);
  });

  it("applies only max_amount to a proven corridor", async () => {
    const c = { ...corridor(), limits: { max_amount: "150" } };
    const i = {
      ...intent("proven-over-canary"),
      sourceAmount: { asset: "USDC", amount: "100" },
    };

    const r = await execute(i, c, { ...deps(), unprovenMaxAmount: "10" });

    expect(r.ok).toBe(true);

    const overMax = await execute(
      {
        ...i,
        idempotencyKey: "proven-over-max",
        sourceAmount: { asset: "USDC", amount: "151" },
      },
      c,
      deps(),
    );
    expect(overMax.ok).toBe(false);
    if (!overMax.ok) expect(overMax.error.code).toBe("AMOUNT_INVALID");
  });

  it("treats stale proof as unproven", async () => {
    const c = {
      ...corridor(),
      proof: {
        ...corridor().proof!,
        canary_completed_at: "2020-01-01T00:00:00Z",
        max_age_days: 1,
        canary_max_amount: "5",
      },
    };
    const i = { ...intent("stale-proof"), sourceAmount: { asset: "USDC", amount: "6" } };
    const r = await execute(i, c, {
      ...deps(),
      now: () => Date.parse("2026-09-29T00:00:00Z"),
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CORRIDOR_UNPROVEN");
  });

  it("refuses unverified public corridors before claiming the key", async () => {
    const store = new InMemoryIdempotencyStore();
    const c = {
      ...corridor(),
      dest: {
        ...corridor().dest,
        endpoints: { ...corridor().dest.endpoints, endpoints_verified_at: undefined },
      } as Corridor["dest"],
    };
    const i = intent("public-unverified");

    const r = await execute(i, c, { ...deps(), idempotency: store });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CORRIDOR_UNPROVEN");
    expect(await store.get(i.idempotencyKey)).toBeUndefined();
  });
});

function resumableRun(state: CorridorState, key = "resume-state"): StoredRun {
  return {
    idempotencyKey: key,
    corridorId: "test",
    state,
    version: 4,
    transactionId: "tx_resume",
    quoteId: "q_resume",
    quoteExpiresAt: Date.now() + 60_000,
    quoteFirm: true,
    settlementAmount: "100.00",
    depositAddress: "GMOCK000000000000000000000000000000000000000000000000",
    memo: "mock-memo",
    memoType: "text",
    stellarTxHash: "mocktx_existing",
  };
}

describe("engine crash resume states", () => {
  it("resumes an opened non-prefunded run by funding before settlement", async () => {
    const store = new InMemoryIdempotencyStore();
    const key = "resume-opened-source";
    await store.put(resumableRun("opened", key));
    const source = createMockSourceAdapter();
    const openDeposit = vi.spyOn(source, "openDeposit");
    const receiving = createMockAdapter();
    const r = await execute(intent(key), corridor("sep6"), {
      ...deps(),
      idempotency: store,
      resolver: {
        async resolve() {
          return { receiving, sending: source, trust: "manifest" as const };
        },
      },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.trail).toContain("funding");
      expect(r.value.trail).toContain("funded");
      expect(r.value.trail.indexOf("funded")).toBeLessThan(r.value.trail.indexOf("settling"));
    }
    expect(openDeposit).toHaveBeenCalledTimes(1);
  });

  it.each(["funding", "funded"] as const)(
    "resumes from %s without opening a second source deposit",
    async (state) => {
      const store = new InMemoryIdempotencyStore();
      const key = "resume-funded";
      const c = corridor();
      const source = createMockSourceAdapter();
      const deposit = await source.openDeposit(intent(key), c);
      if (!deposit.ok) throw new Error("mock source deposit did not open");
      await store.put({
        ...resumableRun(state, key),
        sourceTransactionId: deposit.value.transactionId,
      });
      const openDeposit = vi.spyOn(source, "openDeposit");
      const receiving = createMockAdapter();
      const r = await execute(intent(key), corridor(), {
        ...deps(),
        idempotency: store,
        resolver: {
          async resolve() {
            return { receiving, sending: source, trust: "manifest" as const };
          },
        },
      });
      expect(r.ok).toBe(true);
      expect(openDeposit).not.toHaveBeenCalled();
      expect((await store.get(key))?.sourceTransactionId).toBe(deposit.value.transactionId);
    },
  );

  it.each(["created", "quoted", "compliant"] as const)(
    "%s is failed as stale before anything is sent",
    async (state) => {
      const store = new InMemoryIdempotencyStore();
      const key = `resume-${state}`;
      await store.put({ ...resumableRun(state, key), transactionId: undefined });
      const r = await execute(intent(key), corridor(), { ...deps(), idempotency: store });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toContain("RESUME_STALE");
      expect((await store.get(key))?.state).toBe("failed");
    },
  );

  it.each(["opened", "retrying"] as const)(
    "%s settles after a lookup miss and a fresh compliance gate",
    async (state) => {
      const store = new InMemoryIdempotencyStore();
      const key = `resume-${state}-miss`;
      await store.put(resumableRun(state, key));
      const r = await execute(intent(key), corridor(), { ...deps(), idempotency: store });
      expect(r.ok).toBe(true);
      expect((await store.get(key))?.state).toBe("completed");
    },
  );

  it.each(["opened", "retrying", "settling"] as const)(
    "%s advances to settled when lookup proves the payment exists",
    async (state) => {
      const store = new InMemoryIdempotencyStore();
      const key = `resume-${state}-hit`;
      const submitter = createMockSubmitter();
      const existingPayment = await submitter.submit({
        to: "GMOCK000000000000000000000000000000000000000000000000",
        memo: "mock-memo",
        memoType: "text",
        amount: { asset: "USDC", amount: "100.00" },
        corridor: corridor(),
      });
      expect(existingPayment.ok).toBe(true);
      if (!existingPayment.ok) throw new Error("mock settlement did not succeed");
      expect(existingPayment.value.kind).toBe("stellar");
      if (existingPayment.value.kind !== "stellar")
        throw new Error("expected stellar settlement");
      await store.put({ ...resumableRun(state, key), stellarTxHash: undefined });
      const r = await execute(intent(key), corridor(), {
        ...deps(),
        idempotency: store,
        submitter,
      });
      expect(r.ok).toBe(true);
      expect((await store.get(key))?.state).toBe("completed");
      expect((await store.get(key))?.stellarTxHash).toBe(existingPayment.value.stellarTxHash);
    },
  );

  it("keeps a settling miss conflicted for operator review", async () => {
    const store = new InMemoryIdempotencyStore();
    const key = "resume-settling-miss";
    await store.put(resumableRun("settling", key));
    const r = await execute(intent(key), corridor(), { ...deps(), idempotency: store });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await store.get(key))?.state).toBe("settling");
  });

  it("reconciles a settled run and completes a reconciled run", async () => {
    for (const state of ["settled", "reconciled"] as const) {
      const store = new InMemoryIdempotencyStore();
      const key = `resume-${state}`;
      await store.put(resumableRun(state, key));
      const r = await execute(intent(key), corridor(), { ...deps(), idempotency: store });
      expect(r.ok).toBe(true);
      expect((await store.get(key))?.state).toBe("completed");
    }
  });

  it.each(["recovering", "refund_pending"] as const)(
    "%s continues watching until the receiving anchor reports refund information",
    async (state) => {
      const refundStatus = {
        amountRefunded: { asset: "USDC", amount: "100.00" },
        amountFee: { asset: "USDC", amount: "0" },
        payments: [],
        completeness: "full" as const,
      };
      const store = new InMemoryIdempotencyStore();
      const key = `resume-${state}`;
      await store.put(resumableRun(state, key));
      const r = await execute(intent(key), corridor(), {
        ...deps({ terminalFailure: true, refundStatus }),
        idempotency: store,
      });
      expect(r.ok).toBe(false);
      expect((await store.get(key))?.state).toBe("refunded");
    },
  );

  it("routes a resumed reconcile failure through recovery.rollback", async () => {
    const store = new InMemoryIdempotencyStore();
    const key = "resume-settled-refund";
    await store.put(resumableRun("settled", key));
    const refundStatus = {
      amountRefunded: { asset: "USDC", amount: "100.00" },
      amountFee: { asset: "USDC", amount: "0.00" },
      payments: [
        {
          id: "refund-1",
          amount: { asset: "USDC", amount: "100.00" },
          fee: { asset: "USDC", amount: "0.00" },
        },
      ],
      completeness: "full" as const,
    };
    const r = await execute(
      intent(key),
      corridorWith({ max_retries: 0, rollback: "refund_sender" }),
      {
        ...deps({ terminalFailure: true, refundStatus }),
        idempotency: store,
      },
    );
    expect(r.ok).toBe(false);
    expect((await store.get(key))?.state).toBe("refunded");
    expect((await store.get(key))?.refundId).toBeTruthy();
  });

  describe("manifest pinning on crash resume", () => {
    it("resumes normally when the manifest hash is unchanged", async () => {
      const store = new InMemoryIdempotencyStore();
      const key = "resume-hash-unchanged";
      const c = corridor();
      const hash = hashCorridor(c);
      await store.put({
        ...resumableRun("settled", key),
        manifestHash: hash,
      });

      const r = await execute(intent(key), c, { ...deps(), idempotency: store });
      expect(r.ok).toBe(true);
      expect((await store.get(key))?.state).toBe("completed");
    });

    it("fails with MANIFEST_CHANGED before settle and does not submit payment", async () => {
      const store = new InMemoryIdempotencyStore();
      const key = "resume-hash-changed-before-settle";
      const c = corridor();
      let submitted = false;
      const submitter = createMockSubmitter();
      const origSubmit = submitter.submit.bind(submitter);
      submitter.submit = async (req) => {
        submitted = true;
        return origSubmit(req);
      };

      // Run crashed in 'opened' state under an old manifest hash
      await store.put({
        ...resumableRun("opened", key),
        stellarTxHash: undefined,
        manifestHash: "old_manifest_hash_that_differed_from_current",
      });

      const r = await execute(intent(key), c, {
        ...deps(),
        submitter,
        idempotency: store,
      });

      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("MANIFEST_CHANGED");
        expect(r.error.message).toContain("corridor manifest changed since run opened");
      }
      // Submitter must never have been called: money must not move!
      expect(submitted).toBe(false);
      expect((await store.get(key))?.state).toBe("failed");
    });

    it("continues reconcile only and logs a warning when manifest changed after settle", async () => {
      const store = new InMemoryIdempotencyStore();
      const key = "resume-hash-changed-after-settle";
      const c = corridor();
      let submitted = false;
      const submitter = createMockSubmitter();
      submitter.submit = async () => {
        submitted = true;
        throw new Error("should not be called");
      };

      const warnings: { msg: string; fields?: Record<string, unknown> }[] = [];
      const logger = {
        log: (level: string, msg: string, fields?: Record<string, unknown>) => {
          if (level === "warn") warnings.push({ msg, fields });
        },
      };

      // Run crashed in 'settled' state under an old manifest hash
      await store.put({
        ...resumableRun("settled", key),
        manifestHash: "old_manifest_hash_that_differs",
      });

      const r = await execute(intent(key), c, {
        ...deps(),
        submitter,
        idempotency: store,
        logger,
      });

      expect(r.ok).toBe(true);
      expect((await store.get(key))?.state).toBe("completed");
      expect(submitted).toBe(false);
      expect(warnings.some((w) => w.msg === "corridor.manifest.changed")).toBe(true);
    });

    it("allows legacy runs without a manifest hash to resume (backward compatibility)", async () => {
      const store = new InMemoryIdempotencyStore();
      const key = "resume-legacy-no-hash";
      const c = corridor();
      await store.put({
        ...resumableRun("settled", key),
        manifestHash: undefined,
      });

      const r = await execute(intent(key), c, { ...deps(), idempotency: store });
      expect(r.ok).toBe(true);
      expect((await store.get(key))?.state).toBe("completed");
    });
  });
});

describe("engine route refusal (#257)", () => {
  // The registry resolver fails closed by throwing; any resolver may.
  const refusing: RouteResolver = {
    async resolve() {
      throw new UnattestedAnchorError("d.example", "no attestation on file");
    },
  };

  it("fails a fresh run instead of stranding it in created, with an audit entry", async () => {
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const d = { ...deps(), idempotency: store, audit, resolver: refusing };

    const r = await execute(intent("refused"), corridor(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ROUTE_REFUSED");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("refusing to route through d.example");
    }
    const stored = await store.get("refused");
    expect(stored?.state).toBe("failed");
    expect(stored?.lastError).toMatch(/^ROUTE_REFUSED: /);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      idempotencyKey: "refused",
      from: "created",
      to: "failed",
      error: expect.stringMatching(/^ROUTE_REFUSED: /),
    });

    // The key is spent, and says so, rather than reporting a run still in flight.
    const again = await execute(intent("refused"), corridor(), d);
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(again.error.message).toContain("state=failed");
    }
  });

  it("leaves a settled run untouched and resumable on resume", async () => {
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const key = "refused-resume-settled";
    await store.put(resumableRun("settled", key));
    const before = await store.get(key);

    const r = await execute(intent(key), corridor(), {
      ...deps(),
      idempotency: store,
      audit,
      resolver: refusing,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ROUTE_REFUSED");
    expect(await store.get(key)).toEqual(before);
    expect(audit.entries).toHaveLength(0);

    // Once a route is available again, the same key reconciles to completion.
    const resumed = await execute(intent(key), corridor(), { ...deps(), idempotency: store });
    expect(resumed.ok).toBe(true);
    expect((await store.get(key))?.state).toBe("completed");
  });

  it("fails a run resumed from created, which moved no money", async () => {
    const store = new InMemoryIdempotencyStore();
    const key = "refused-resume-created";
    await store.put({ ...resumableRun("created", key), transactionId: undefined });

    const r = await execute(intent(key), corridor(), {
      ...deps(),
      idempotency: store,
      resolver: refusing,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ROUTE_REFUSED");
    expect((await store.get(key))?.state).toBe("failed");
  });
});

// Helper: build a corridor with custom recovery policy / timeout.
function corridorWith(recovery: Record<string, unknown>): Corridor {
  const r = parseCorridor({
    id: "test",
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
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery,
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

describe("engine recovery", () => {
  it("refunds the sender when settlement fails and no payment went out", async () => {
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter({ failSubmit: true }),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const r = await execute(
      intent(),
      corridorWith({ max_retries: 1, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_FAILED");
  });

  it("reverses the on-chain payment when reconcile times out (refund path)", async () => {
    let t = 0;
    const refunded: string[] = [];
    const base = createMockSubmitter();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        submit: base.submit,
        refund: async (req) => {
          refunded.push(settlementId(req.original));
          return base.refund(req);
        },
      },
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const r = await execute(
      intent(),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("polls=3");
      expect(r.error.message).toContain("elapsed=1000ms");
      expect(r.error.message).toContain("first status=pending_receiver");
      expect(r.error.message).toContain("last status=pending_receiver");
    }
    // a settlement went out, so the engine must have reversed it on-chain
    expect(refunded).toHaveLength(1);
  });

  it("SETTLEMENT_TIMEOUT carries poll count, elapsed ms, and first/last status in error message", async () => {
    let clock = 1000;
    let pollCount = 0;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async () => {
        pollCount++;
        const status = pollCount === 1 ? "pending_sender" : "pending_receiver";
        return {
          ok: true as const,
          value: {
            status,
            settled: false,
            terminalFailure: false,
          },
        };
      },
    };

    const r = await reconcileUntil(adapter, "tx-stall", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      deadlineMs: 3000,
      pollMs: 1000,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("tx tx-stall did not settle before timeout");
      expect(r.error.message).toContain("polls=3");
      expect(r.error.message).toContain("elapsed=2000ms");
      expect(r.error.message).toContain("first status=pending_sender");
      expect(r.error.message).toContain("last status=pending_receiver");
    }
  });

  it("does not poll-count-stall an external phase within its elapsed-time budget", async () => {
    let pollCount = 0;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async () => {
        pollCount += 1;
        return {
          ok: true as const,
          value: {
            status: pollCount <= 100 ? "pending_external" : "completed",
            phase: pollCount <= 100 ? ("external" as const) : undefined,
            settled: pollCount > 100,
            terminalFailure: false,
          },
        };
      },
    };

    const r = await reconcileUntil(adapter, "tx-external", {
      now: () => 0,
      sleep: async () => {},
      deadlineMs: 1_000_000,
      pollMs: 1_000,
      stallThreshold: 10,
      externalStallMs: 60_000,
    });

    expect(r.ok).toBe(true);
    expect(pollCount).toBe(101);
  });

  it("poll-count-stalls an unchanged anchor phase after the configured threshold", async () => {
    let pollCount = 0;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async () => {
        pollCount += 1;
        return {
          ok: true as const,
          value: {
            status: "pending_stellar",
            phase: "anchor" as const,
            settled: false,
            terminalFailure: false,
          },
        };
      },
    };

    const r = await reconcileUntil(adapter, "tx-anchor", {
      now: () => 0,
      sleep: async () => {},
      deadlineMs: 1_000_000,
      pollMs: 1_000,
      stallThreshold: 10,
      externalStallMs: 60_000,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("RECONCILE_STALLED");
      expect(r.error.message).toContain("poll stall budget");
    }
    expect(pollCount).toBe(11);
  });

  it("backs off during external waits and resets the interval when status changes", async () => {
    let pollCount = 0;
    const delays: number[] = [];
    const statuses = [
      ["pending_external", "external"],
      ["pending_external", "external"],
      ["pending_receiver", "external"],
      ["pending_stellar", "anchor"],
      ["completed", undefined],
    ] as const;
    const adapter = {
      ...createMockAdapter(),
      getTransaction: async () => {
        const [status, phase] = statuses[pollCount++];
        return {
          ok: true as const,
          value: {
            status,
            ...(phase ? { phase } : {}),
            settled: status === "completed",
            terminalFailure: false,
          },
        };
      },
    };

    const r = await reconcileUntil(adapter, "tx-backoff", {
      now: () => 0,
      sleep: async (ms) => {
        delays.push(ms);
      },
      deadlineMs: 1_000_000,
      pollMs: 1_000,
      stallThreshold: 10,
    });

    expect(r.ok).toBe(true);
    expect(delays).toEqual([1_000, 2_000, 1_000, 1_000]);
  });

  it("SETTLEMENT_TIMEOUT records identical first and last status for a stalled observer", async () => {
    let clock = 0;
    const adapter = createMockAdapter({ settled: false }); // returns pending_receiver

    const r = await reconcileUntil(adapter, "tx-never-moves", {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      deadlineMs: 2000,
      pollMs: 500,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("polls=5");
      expect(r.error.message).toContain("first status=pending_receiver");
      expect(r.error.message).toContain("last status=pending_receiver");
    }
  });

  it("says so in the timeout when the anchor was blocked on someone's input", async () => {
    // An operator reading a SETTLEMENT_TIMEOUT needs to know who to chase. A run
    // that timed out on `pending_customer_info_update` was waiting on a party to
    // supply information, not on a slow anchor — the message must say which.
    let t = 0;
    const base = createMockAdapter({ settled: false });
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(
        () => ({
          ...base,
          getTransaction: async () =>
            ok({
              status: "pending_customer_info_update",
              settled: false,
              terminalFailure: false,
              awaitingInput: true,
            }),
        }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const r = await execute(
      intent("awaiting-input"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "hold" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      expect(r.error.message).toContain("pending_customer_info_update");
      expect(r.error.message).toContain("awaiting input from another party");
    }
  });

  it("persists the refund id so a resumed run has evidence it already refunded", async () => {
    // Without this, a run records that the payment went out but not that the
    // refund did — and a resumed process asks for a second one. Not settling
    // twice, but money moving twice.
    let t = 0;
    const store = new InMemoryIdempotencyStore();
    const base = createMockSubmitter();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: base,
      idempotency: store,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const i = intent();
    await execute(
      i,
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      d,
    );

    const stored = await store.get(i.idempotencyKey);
    expect(stored?.state).toBe("refunded");
    expect(stored?.stellarTxHash).toBeTruthy();
    expect(stored?.refundId).toBeTruthy();
    expect(stored?.refundId).not.toBe(stored?.stellarTxHash);
    expect(hasRequestedRefund(stored!)).toBe(true);
  });

  it("does not issue a second refund for a key that already refunded", async () => {
    let t = 0;
    const refunded: string[] = [];
    const store = new InMemoryIdempotencyStore();
    const base = createMockSubmitter();
    const deps = (): EngineDeps => ({
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        submit: base.submit,
        refund: async (req) => {
          refunded.push(settlementId(req.original));
          return base.refund(req);
        },
      },
      idempotency: store,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    });
    const c = corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" });
    const i = intent();

    await execute(i, c, deps());
    expect(refunded).toHaveLength(1);

    // Re-running the same key must not send the money back again.
    const again = await execute(i, c, deps());
    expect(again.ok).toBe(false);
    expect(refunded).toHaveLength(1);
  });

  it("bails out of reconcile immediately on a terminal anchor failure", async () => {
    let t = 0;
    let polls = 0;
    const refunded: string[] = [];
    const base = createMockSubmitter();
    // The anchor reports a full refund alongside its terminal status, so the
    // refund watcher (#173) settles on its first poll.
    const failing = createMockAdapter({
      terminalFailure: true,
      refundStatus: {
        amountRefunded: { asset: "USDC", amount: "100.00" },
        amountFee: { asset: "USDC", amount: "0.00" },
        payments: [
          {
            id: "refund-1",
            amount: { asset: "USDC", amount: "100.00" },
            fee: { asset: "USDC", amount: "0.00" },
          },
        ],
        completeness: "full",
      },
    });
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(
        () => ({
          ...failing,
          getTransaction: async (id) => {
            polls += 1;
            return failing.getTransaction(id);
          },
        }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter: {
        submit: base.submit,
        refund: async (req) => {
          refunded.push(settlementId(req.original));
          return base.refund(req);
        },
      },
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      // A long timeout: if the engine waited it out instead of bailing, the test
      // would still pass on the error code — so assert it polled only once.
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const r = await execute(
      intent("terminal-1"),
      corridorWith({ max_retries: 0, timeout_seconds: 3600, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
    // One reconcile poll (bailed on the first terminal status instead of polling
    // to timeout) plus one refund-watch poll that read the anchor's report.
    expect(polls).toBe(2);
    // The anchor is already refunding: the run goes through refund_pending and
    // the engine does not ask the chain to reverse the payment (#171).
    expect(refunded).toHaveLength(0);
  });

  it("escalates a REFUND_UNSUPPORTED refund to held (fail-closed refund path)", async () => {
    // A settlement went out, recovery wants to refund, but the refund port
    // reports the operation is not supported at all (e.g. SEP-31 has no
    // sender-initiated refund endpoint). Non-retryable and non-actionable by
    // the engine: the only safe landing is `held`, for a human, with the
    // refusal recorded — never a retry loop, never an invented endpoint.
    let t = 0;
    const base = createMockSubmitter();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ settled: false }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        submit: base.submit,
        refund: async () =>
          fail("REFUND_UNSUPPORTED", "no sender-initiated refund endpoint", {
            retryable: false,
          }),
      },
      idempotency: new InMemoryIdempotencyStore(),
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const store = d.idempotency!;
    const r = await execute(
      intent("refund-unsupported"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("REFUND_UNSUPPORTED");
    const stored = await store.get("refund-unsupported");
    expect(stored?.state).toBe("held");
  });

  it("parks for manual intervention when rollback policy is hold", async () => {
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter({ failSubmit: true }),
      idempotency: new InMemoryIdempotencyStore(),
      sleep: async () => {},
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const store = d.idempotency!;
    const r = await execute(
      intent("hold-1"),
      corridorWith({ max_retries: 0, rollback: "hold" }),
      d,
    );
    expect(r.ok).toBe(false);
    const stored = await store.get("hold-1");
    expect(stored?.state).toBe("held");
  });
});

describe("reconcile stall detection", () => {
  // Build a tiny AnchorAdapter whose getTransaction always (or consecutively)
  // returns the supplied status, while delegating everything else to the mock.
  const stalledAdapter = (status: string) => {
    let polls = 0;
    const adapter = {
      ...createMockAdapter({ settled: false }),
      getTransaction: async (): Promise<Outcome<TransactionStatus>> => {
        polls++;
        return ok<TransactionStatus>({
          status,
          settled: false,
          terminalFailure: false,
        });
      },
    };
    return { adapter, polls: () => polls };
  };

  it("returns RECONCILE_STALLED when status stays the same for stallThreshold polls", async () => {
    const { adapter, polls } = stalledAdapter("pending_receiver");
    let t = 0;
    const result = await reconcileUntil(adapter, "tx_stall", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 600_000,
      pollMs: 100,
      stallThreshold: 3,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("RECONCILE_STALLED");
      expect(result.error.retryable).toBe(false);
      expect(result.error.message).toContain("pending_receiver");
      expect(result.error.message).toContain("3");
    }
    expect(polls()).toBe(4); // threshold + 1 (the poll that triggers the bail)
  });

  it("does NOT stall when the status advances between polls", async () => {
    let callIdx = 0;
    const adapter = {
      ...createMockAdapter({ settled: false }),
      getTransaction: async (): Promise<Outcome<TransactionStatus>> => {
        callIdx++;
        // Every poll returns a different status — sameCount never accumulates.
        return ok<TransactionStatus>({ status: `status_${callIdx}`, settled: false });
      },
    };
    let t = 0;
    const result = await reconcileUntil(adapter, "tx_no_stall", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 100,
      pollMs: 10,
      stallThreshold: 3,
    });
    // Should time out, NOT stall — because the status keeps advancing,
    // resetting the consecutive counter on every poll.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SETTLEMENT_TIMEOUT");
    }
    expect(callIdx).toBeGreaterThan(3);
  });

  it("stalls exactly at threshold, not before", async () => {
    const { adapter, polls } = stalledAdapter("stuck");
    let t = 0;
    // First poll sets lastStatus="stuck" with sameCount=0; each subsequent poll
    // increments sameCount. So threshold=N means the stall fires on poll N+1.
    const result = await reconcileUntil(adapter, "tx_exact", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 600_000,
      pollMs: 100,
      stallThreshold: 5,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("RECONCILE_STALLED");
    expect(polls()).toBe(6);
  });

  it("does NOT stall when stallThreshold is omitted (disabled at this layer)", async () => {
    const { adapter, polls } = stalledAdapter("stuck");
    let t = 0;
    // reconcileUntil reads `opts.stallThreshold ?? 0`, so omitting the option
    // disables stall detection here: an anchor stuck on one status forever has
    // to reach the deadline timeout rather than return RECONCILE_STALLED.
    // (execute() applies the production default of 10 one level up in run.ts.)
    const result = await reconcileUntil(adapter, "tx_omitted_threshold", {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      deadlineMs: t + 500,
      pollMs: 100,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("SETTLEMENT_TIMEOUT");
    expect(polls()).toBeGreaterThan(1);
  });
});

describe("state machine", () => {
  it("permits the forward path and forbids skips", () => {
    expect(canTransition("created", "quoted")).toBe(true);
    expect(canTransition("settling", "settled")).toBe(true);
    expect(canTransition("created", "settled")).toBe(false);
    expect(canTransition("completed", "settling")).toBe(false);
  });

  it("routes the settle retry loop through `retrying`, not `recovering`", () => {
    // These were one state, and this test used to assert
    // `canTransition("recovering", "settling") === true` — which, combined with
    // `settled -> recovering`, made `settled -> recovering -> settling` a legal
    // path: a re-submission of a payment that had already gone out. A property
    // test walking the graph found it. The two kinds of recovery are now
    // distinct so the double-spend is unreachable by construction.
    expect(canTransition("settling", "retrying")).toBe(true);
    expect(canTransition("retrying", "verifying")).toBe(true);
    expect(canTransition("retrying", "settling")).toBe(false);

    // `recovering` is terminal-bound and cannot get back to the chain.
    expect(canTransition("recovering", "settling")).toBe(false);
    expect(canTransition("recovering", "refunded")).toBe(true);
    expect(canTransition("recovering", "held")).toBe(true);

    // And the path that motivated the split stays closed.
    expect(canTransition("settled", "settling")).toBe(false);
    expect(canTransition("settled", "recovering")).toBe(true);
  });

  it("watches an anchor-driven full refund and records its first refund id", async () => {
    let t = 0;
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(
        () =>
          createMockAdapter({
            terminalFailure: true,
            refundStatus: {
              amountRefunded: { asset: "USDC", amount: "100.00" },
              amountFee: { asset: "USDC", amount: "1.00" },
              payments: [
                {
                  id: "refund-payment-1",
                  amount: { asset: "USDC", amount: "100.00" },
                  fee: { asset: "USDC", amount: "1.00" },
                },
              ],
              completeness: "full",
            },
          }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter: createMockSubmitter(),
      idempotency: store,
      audit,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    const r = await execute(
      intent("refund-watch-full"),
      corridorWith({ max_retries: 0, refund_wait_seconds: 60, rollback: "refund_sender" }),
      d,
    );
    expect(r.ok).toBe(false);
    const stored = await store.get("refund-watch-full");
    expect(stored?.state).toBe("refunded");
    expect(stored?.refundId).toBe("refund-payment-1");
    expect(audit.entries.find((entry) => entry.to === "refunded")).toMatchObject({
      amountRefunded: "100.00",
      amountFee: "1.00",
    });
  });

  it("holds a partial refund with the reported amounts", async () => {
    const store = new InMemoryIdempotencyStore();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(
        () =>
          createMockAdapter({
            terminalFailure: true,
            refundStatus: {
              amountRefunded: { asset: "USDC", amount: "40.00" },
              amountFee: { asset: "USDC", amount: "1.00" },
              payments: [],
              completeness: "partial",
            },
          }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter: createMockSubmitter(),
      idempotency: store,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    await execute(
      intent("refund-watch-partial"),
      corridorWith({ max_retries: 0, refund_wait_seconds: 60, rollback: "refund_sender" }),
      d,
    );
    const stored = await store.get("refund-watch-partial");
    expect(stored?.state).toBe("held");
    expect(stored?.lastError).toContain("amountRefunded=40.00 USDC");
  });

  it("holds when an anchor never reports a refund before the window", async () => {
    let t = 0;
    const store = new InMemoryIdempotencyStore();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: store,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    await execute(
      intent("refund-watch-timeout"),
      corridorWith({ max_retries: 0, refund_wait_seconds: 1, rollback: "refund_sender" }),
      d,
    );
    const stored = await store.get("refund-watch-timeout");
    expect(stored?.state).toBe("held");
    expect(stored?.lastError).toContain("refund for tx");
    expect(stored?.lastError).toContain("timeout");
  });
});

// --- the refund path ------------------------------------------------------
//
// `refundAndStop` is the branch that runs after something has already gone
// wrong, which is exactly when it is least likely to have been exercised by
// hand. Every case below goes through the mock adapter and mock submitter — no
// network, per CONTRIBUTING.md — and reads the outcome from the store and the
// audit log rather than the return value, because a recovered run always
// returns an error: the interesting part is *where it stopped*.

interface RefundHarness {
  deps: EngineDeps;
  store: InMemoryIdempotencyStore;
  audit: InMemoryAuditLog;
  /** Every refund the engine asked for. Empty means it never touched the chain. */
  refundCalls: { stellarTxHash: string; reason?: string }[];
  /** The states the run passed through, in order, per the audit log. */
  trail: () => CorridorState[];
}

function refundHarness(
  opts: {
    /** Make the on-chain settlement itself fail, so no payment ever goes out. */
    failSubmit?: boolean;
    /** Make the refund fail, standing in for an anchor that refuses it. */
    refundError?: string;
    /** Anchor never reports the payment as settled, so reconcile times out. */
    settled?: boolean;
  } = {},
): RefundHarness {
  const base = createMockSubmitter({ failSubmit: opts.failSubmit ?? false });
  const refundCalls: RefundHarness["refundCalls"] = [];
  const store = new InMemoryIdempotencyStore();
  const audit = new InMemoryAuditLog();
  let t = 0;

  const submitter: SettlementSubmitter = {
    submit: base.submit,
    async refund(req) {
      refundCalls.push({ stellarTxHash: settlementId(req.original), reason: req.reason });
      if (opts.refundError) {
        return fail("SETTLEMENT_FAILED", opts.refundError, { retryable: false });
      }
      return base.refund(req);
    },
  };

  return {
    store,
    audit,
    refundCalls,
    trail: () => audit.entries.map((e) => e.to),
    deps: {
      resolver: new StaticRouteResolver(
        () => createMockAdapter({ settled: opts.settled ?? true }),
        { trustManifestWithoutAttestation: true },
      ),
      submitter,
      idempotency: store,
      audit,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    },
  };
}

describe("engine refund path", () => {
  it("reaches refunded when the anchor accepts the refund", async () => {
    const h = refundHarness({ settled: false });
    const r = await execute(
      intent("refund-ok"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );

    // A recovered run still reports the failure that caused it.
    expect(r.ok).toBe(false);

    const run = await h.store.get("refund-ok");
    expect(run?.state).toBe("refunded");
    expect(h.trail()).toEqual([
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "recovering",
      "refunded",
    ]);

    // The refund reversed the payment that actually went out, and carries the
    // reason so the anchor's own record says why.
    expect(h.refundCalls).toHaveLength(1);
    expect(h.refundCalls[0]?.stellarTxHash).toBe(run?.stellarTxHash);
    expect(h.refundCalls[0]?.reason).toContain("SETTLEMENT_TIMEOUT");
  });

  it("escalates to held when the refund is rejected, keeping the anchor's reason", async () => {
    const h = refundHarness({
      settled: false,
      refundError: "anchor refused the refund: destination account closed",
    });
    const r = await execute(
      intent("refund-rejected"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );

    expect(r.ok).toBe(false);

    const run = await h.store.get("refund-rejected");
    // Money left and could not be returned: a human has to look at it, and the
    // run must not look finished.
    expect(run?.state).toBe("held");
    expect(run?.lastError).toContain("destination account closed");
    expect(h.trail().at(-1)).toBe("held");
    expect(h.refundCalls).toHaveLength(1);
  });

  it("records the refund without touching the chain when no payment went out", async () => {
    const h = refundHarness({ failSubmit: true });
    const r = await execute(
      intent("refund-no-payment"),
      corridorWith({ max_retries: 1, rollback: "refund_sender" }),
      h.deps,
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SETTLEMENT_FAILED");

    const run = await h.store.get("refund-no-payment");
    expect(run?.state).toBe("refunded");
    expect(run?.stellarTxHash).toBeUndefined();
    // Nothing is on-chain to reverse — the sending anchor returns the sender's
    // funds off-chain — so the engine must not ask the submitter to reverse it.
    expect(h.refundCalls).toEqual([]);
  });

  it("never attempts a refund when the corridor says hold", async () => {
    const h = refundHarness({ settled: false });
    const r = await execute(
      intent("rollback-hold"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "hold" }),
      h.deps,
    );

    expect(r.ok).toBe(false);

    const run = await h.store.get("rollback-hold");
    expect(run?.state).toBe("held");
    expect(run?.lastError).toContain("SETTLEMENT_TIMEOUT");
    expect(h.refundCalls).toEqual([]);
    expect(h.trail().at(-1)).toBe("held");
  });

  it("fails without a refund when the corridor says manual", async () => {
    const h = refundHarness({ settled: false });
    const r = await execute(
      intent("rollback-manual"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "manual" }),
      h.deps,
    );

    expect(r.ok).toBe(false);

    const run = await h.store.get("rollback-manual");
    expect(run?.state).toBe("failed");
    expect(h.refundCalls).toEqual([]);
    expect(h.trail()).not.toContain("refunded");
  });

  it("never re-enters settling once the refund path has been taken", async () => {
    // The invariant, asserted on a real run rather than only on the table: a
    // run that has settled and then recovered must never submit again.
    const h = refundHarness({ settled: false });
    await execute(
      intent("no-resettle"),
      corridorWith({ max_retries: 2, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );

    const afterRecovering = h.trail().slice(h.trail().indexOf("recovering"));
    expect(afterRecovering).not.toContain("settling");
    expect(afterRecovering).not.toContain("retrying");
  });
});

describe("per-corridor reconcile config", () => {
  function harness(polled: number[], sleeps: number[]) {
    const adapter = {
      ...createMockAdapter({ settled: false }),
      getTransaction: async (): Promise<Outcome<TransactionStatus>> => {
        polled.push(1);
        return ok<TransactionStatus>({ status: "pending_receiver", settled: false });
      },
    };
    let t = 0;
    const store = new InMemoryIdempotencyStore();
    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: store,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      // Deps values that the manifest must override.
      reconcilePollMs: 7,
      stallThreshold: 10,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    return { d, store };
  }
  const rc = {
    rollback: "hold",
    timeout_seconds: 900,
    reconcile: { poll_seconds: 3, stall_polls: 2 },
  };

  it("manifest stall_polls and poll_seconds override the EngineDeps values", async () => {
    const polled: number[] = [];
    const sleeps: number[] = [];
    const { d } = harness(polled, sleeps);
    const r = await execute(intent("rc-1"), corridorWith(rc), d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_STALLED");
    expect(polled).toHaveLength(3); // stall_polls (2) + 1, not deps' 10 + 1
    expect(sleeps).toContain(3000);
    expect(sleeps).not.toContain(7);
  });

  it("falls back to EngineDeps when the manifest sets nothing", async () => {
    const polled: number[] = [];
    const sleeps: number[] = [];
    const { d } = harness(polled, sleeps);
    d.stallThreshold = 2;
    await execute(intent("rc-2"), corridorWith({ rollback: "hold" }), d);
    expect(polled).toHaveLength(3);
    expect(sleeps).toContain(7);
  });

  it("stall_polls: 0 disables stall detection for the corridor", async () => {
    const polled: number[] = [];
    const sleeps: number[] = [];
    const { d } = harness(polled, sleeps);
    const r = await execute(
      intent("rc-3"),
      corridorWith({
        rollback: "hold",
        timeout_seconds: 30,
        reconcile: { poll_seconds: 5, stall_polls: 0 },
      }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).not.toBe("RECONCILE_STALLED");
    expect(polled.length).toBeGreaterThan(3);
  });

  it("a resumed run uses the manifest values too", async () => {
    const polled: number[] = [];
    const sleeps: number[] = [];
    const { d, store } = harness(polled, sleeps);
    await store.put({
      idempotencyKey: "rc-resume",
      corridorId: "test",
      state: "settled",
      version: 5,
      transactionId: "tx_1",
      stellarTxHash: "mocktx1",
    });
    const r = await execute(intent("rc-resume"), corridorWith(rc), d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_STALLED");
    expect(polled).toHaveLength(3);
    expect(sleeps).toContain(3000);
  });
});

describe("refund_pending producer", () => {
  it("enters refund_pending, without calling submitter.refund, and holds when the anchor never reports the refund", async () => {
    const h = refundHarness();
    const d: EngineDeps = {
      ...h.deps,
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
    };
    const r = await execute(
      intent("rp-1"),
      corridorWith({
        max_retries: 0,
        timeout_seconds: 3600,
        refund_wait_seconds: 1,
        rollback: "refund_sender",
      }),
      d,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
    expect((await h.store.get("rp-1"))?.state).toBe("held");
    expect(h.trail()).toEqual([
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "recovering",
      "refund_pending",
      "held",
    ]);
    expect(h.refundCalls).toHaveLength(0);
    expect((await h.store.get("rp-1"))?.refundId).toBeUndefined();
  });

  it("does not treat a reconcile timeout as an anchor refund: still reverses via the submitter", async () => {
    const h = refundHarness({ settled: false });
    await execute(
      intent("rp-2"),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      h.deps,
    );
    expect((await h.store.get("rp-2"))?.state).toBe("refunded");
    expect(h.refundCalls).toHaveLength(1);
  });

  it("no-hash path (settle never succeeded) still ends refunded without touching the chain", async () => {
    const h = refundHarness({ failSubmit: true });
    await execute(
      intent("rp-3"),
      corridorWith({ max_retries: 0, timeout_seconds: 60, rollback: "refund_sender" }),
      h.deps,
    );
    expect((await h.store.get("rp-3"))?.state).toBe("refunded");
    expect(h.refundCalls).toHaveLength(0);
  });

  it("hold policy is unchanged: anchor error after settle ends held", async () => {
    const h = refundHarness();
    const d: EngineDeps = {
      ...h.deps,
      resolver: new StaticRouteResolver(() => createMockAdapter({ terminalFailure: true }), {
        trustManifestWithoutAttestation: true,
      }),
    };
    await execute(
      intent("rp-4"),
      corridorWith({ max_retries: 0, timeout_seconds: 3600, rollback: "hold" }),
      d,
    );
    expect((await h.store.get("rp-4"))?.state).toBe("held");
  });
});

describe("Quote fee and settlement amount validation", () => {
  it("fails with AMOUNT_INVALID before settling when quote sell_amount exceeds STROOP_SCALE precision", async () => {
    const store = new InMemoryIdempotencyStore();
    const adapter = createMockAdapter();
    // Override requestQuote to return 8 decimal places
    adapter.requestQuote = async () =>
      ok({
        id: "q-8dp",
        price: "1.0",
        expiresAt: Date.now() + 60_000,
        sourceAmount: { asset: "USDC", amount: "100.12345678" },
        destAmount: { asset: "ARS", amount: "100" },
        firm: true,
      });

    let submitted = 0;
    const mockSubmitter = createMockSubmitter();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        ...mockSubmitter,
        submit: async (req) => {
          submitted += 1;
          return mockSubmitter.submit(req);
        },
      },
      idempotency: store,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent("invalid-dp-quote"), corridor(), deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("AMOUNT_INVALID");
    }

    const stored = await store.get("invalid-dp-quote");
    expect(stored?.state).toBe("failed");
    // It died before anything was submitted: the 8dp amount was never rounded or sent.
    expect(submitted).toBe(0);
    expect(stored?.lastError).toContain("AMOUNT_INVALID");
  });

  it("records quoteFee and networkFee in the settled audit entry", async () => {
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const adapter = createMockAdapter({ settled: true });
    adapter.requestQuote = async () =>
      ok({
        id: "q-with-fee",
        price: "1.0",
        expiresAt: Date.now() + 60_000,
        sourceAmount: { asset: "USDC", amount: "100.00" },
        destAmount: { asset: "ARS", amount: "100.00" },
        fee: { asset: "USDC", amount: "0.50" },
        firm: true,
      });

    const submitter: SettlementSubmitter = {
      submit: async () =>
        ok({
          kind: "stellar",
          stellarTxHash: "tx-fee-hash",
          ledger: 12345,
          feeCharged: "100",
        }),
      refund: async () => fail("REFUND_UNSUPPORTED", "no"),
    };

    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: store,
      audit,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent("audit-fee-key"), corridor(), deps);
    expect(r.ok).toBe(true);

    const settledEntry = audit.entries.find((e) => e.to === "settled");
    expect(settledEntry).toBeDefined();
    expect(settledEntry?.quoteFee).toEqual({ asset: "USDC", amount: "0.50" });
    expect(settledEntry?.networkFee).toBe("100");
  });
});

describe("engine chain verifier", () => {
  it("passes the settlement request and continues to completed when the verifier accepts", async () => {
    const h = refundHarness();
    const seen: { to: string; amount: string; hash: string }[] = [];
    const r = await execute(
      intent("cv-ok"),
      corridorWith({ max_retries: 0, timeout_seconds: 60, rollback: "hold" }),
      {
        ...h.deps,
        chainVerifier: async (ref, req) => {
          seen.push({ to: req.to, amount: req.amount.amount, hash: settlementId(ref) });
          return ok(undefined);
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.amount).toBe("100.00");
    expect(h.trail()).toContain("reconciled");
  });

  it("ends held under the hold policy when the verifier fails after settled", async () => {
    const h = refundHarness();
    const r = await execute(
      intent("cv-bad"),
      corridorWith({ max_retries: 0, timeout_seconds: 60, rollback: "hold" }),
      {
        ...h.deps,
        chainVerifier: async () =>
          fail("RECONCILE_MISMATCH", "amount expected 100.00, on-chain 1", {
            retryable: false,
          }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECONCILE_MISMATCH");
    expect((await h.store.get("cv-bad"))?.state).toBe("held");
    expect(h.trail()).toEqual([
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "settling",
      "settled",
      "recovering",
      "held",
    ]);
    expect(h.trail()).not.toContain("reconciled");
  });

  it("re-verifies on resume from settled and holds on mismatch", async () => {
    const h = refundHarness();
    await h.store.put({
      idempotencyKey: "cv-resume",
      corridorId: "test",
      state: "settled",
      version: 5,
      transactionId: "tx_1",
      stellarTxHash: "mocktx1",
      settlement: { to: "GDEST", amount: { asset: "USDC", amount: "100.00" } },
    });
    let got: string | undefined;
    const r = await execute(
      intent("cv-resume"),
      corridorWith({ max_retries: 0, timeout_seconds: 60, rollback: "hold" }),
      {
        ...h.deps,
        chainVerifier: async (_ref, req) => {
          got = req.to;
          return fail("RECONCILE_MISMATCH", "destination differs", { retryable: false });
        },
      },
    );
    expect(got).toBe("GDEST");
    expect(r.ok).toBe(false);
    expect((await h.store.get("cv-resume"))?.state).toBe("held");
  });
});

describe("pre-settle gate enforcement", () => {
  it("fails fast with ENGINE_MISCONFIGURED and creates no run record when neither gate nor opt-out is provided", async () => {
    const store = new InMemoryIdempotencyStore();
    const r = await execute(intent("no-gate"), corridor(), {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: store,
      trustManifestWithoutAttestation: true,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("ENGINE_MISCONFIGURED");
      expect(r.error.retryable).toBe(false);
    }
    // Verify no run was persisted in the store
    const stored = await store.get("no-gate");
    expect(stored).toBeUndefined();
  });

  it("records gate.skipped check and logs a warning when unsafeSkipPreSettleGate is enabled", async () => {
    const audit = new InMemoryAuditLog();
    const warnings: string[] = [];
    const r = await execute(intent("skipped-gate"), corridor(), {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      audit,
      unsafeSkipPreSettleGate: true,
      logger: {
        log(level, msg) {
          if (level === "warn") warnings.push(msg);
        },
      },
    });

    expect(r.ok).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("unsafeSkipPreSettleGate");

    const verifyingEntry = audit.entries.find((e) => e.to === "verifying");
    expect(verifyingEntry).toBeDefined();
    expect(verifyingEntry?.checks).toBeDefined();
    expect(verifyingEntry?.checks?.[0]).toEqual({
      name: "gate.skipped",
      passed: true,
      detail: "unsafeSkipPreSettleGate",
      durationMs: 0,
    });
  });

  it("fails in verifying state and does not call submitter.submit when a gate check fails", async () => {
    let submitCalled = false;
    const audit = new InMemoryAuditLog();
    const store = new InMemoryIdempotencyStore();
    const failingGate: PreSettleGate = {
      evaluate: async () => ({
        passed: false,
        results: [
          {
            name: "test.check",
            passed: false,
            detail: "simulated gate failure",
            code: "PRESETTLE_ANCHOR_DRIFT",
            durationMs: 5,
          },
        ],
      }),
    };

    const r = await execute(intent("failing-gate"), corridor(), {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: {
        submit: async () => {
          submitCalled = true;
          return fail("SETTLEMENT_FAILED", "should not be called", { retryable: false });
        },
        refund: async () => fail("SETTLEMENT_FAILED", "not reached", { retryable: false }),
      },
      idempotency: store,
      trustManifestWithoutAttestation: true,
      audit,
      gate: failingGate,
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("PRESETTLE_ANCHOR_DRIFT");
    }
    expect(submitCalled).toBe(false);

    const stored = await store.get("failing-gate");
    expect(stored?.state).toBe("failed");
    expect(stored?.lastError).toContain("PRESETTLE_ANCHOR_DRIFT");

    const verifyingEntry = audit.entries.find((e) => e.to === "verifying");
    expect(verifyingEntry?.checks).toHaveLength(1);
    expect(verifyingEntry?.checks?.[0].passed).toBe(false);
  });

  it("re-evaluates gate after retry", async () => {
    let gateEvaluations = 0;
    let submitCalls = 0;
    const dynamicGate: PreSettleGate = {
      evaluate: async () => {
        gateEvaluations++;
        return {
          passed: true,
          results: [{ name: "gate.dynamic", passed: true, detail: "ok", durationMs: 1 }],
        };
      },
    };

    const submitter: SettlementSubmitter = {
      submit: async () => {
        submitCalls++;
        if (submitCalls === 1) {
          return fail("SETTLEMENT_FAILED", "transient failure", { retryable: true });
        }
        return ok({ kind: "stellar", stellarTxHash: "0xabc", anchorTxId: "tx-123" });
      },
      refund: async () => fail("SETTLEMENT_FAILED", "not reached", { retryable: false }),
    };

    const r = await execute(intent("gate-retry"), corridorWith({ max_retries: 2 }), {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      gate: dynamicGate,
      sleep: async () => {},
    });

    expect(r.ok).toBe(true);
    expect(submitCalls).toBe(2);
    // Gate was evaluated before first settle and re-evaluated before retry settle
    expect(gateEvaluations).toBe(2);
  });
});

describe("engine dry run", () => {
  const passingGate: PreSettleGate = {
    evaluate: async () => ({
      passed: true,
      results: [
        { name: "anchor.drift", passed: true, detail: "toml unchanged", durationMs: 2 },
        {
          name: "chain.balance",
          passed: true,
          detail: "balance covers amount",
          durationMs: 3,
        },
      ],
    }),
  };

  function harness(gate: PreSettleGate = passingGate) {
    const calls = { submit: 0, findExisting: 0 };
    const submitter: SettlementSubmitter = {
      submit: async () => {
        calls.submit++;
        return ok({ kind: "stellar", stellarTxHash: "0xshould-not-exist" });
      },
      findExisting: async () => {
        calls.findExisting++;
        return ok(undefined);
      },
      refund: async () => fail("SETTLEMENT_FAILED", "not reached", { retryable: false }),
    };
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const health = new InMemoryCorridorHealthStore();
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(), {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: store,
      audit,
      health,
      trustManifestWithoutAttestation: true,
      gate,
    };
    return { deps, calls, store, audit, health };
  }

  it("stops after the gate without ever calling submit() or findExisting()", async () => {
    const h = harness();
    const r = await execute(intent("dry-1"), corridor(), h.deps, { dryRun: true });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("DRY_RUN_COMPLETE");
      expect(r.error.retryable).toBe(false);
      expect(r.error.cause).toEqual({
        dryRun: true,
        checks: [
          expect.objectContaining({ name: "anchor.drift", passed: true }),
          expect.objectContaining({ name: "chain.balance", passed: true }),
        ],
      });
    }
    expect(h.calls).toEqual({ submit: 0, findExisting: 0 });

    const stored = await h.store.get("dry-1");
    expect(stored?.state).toBe("failed");
    expect(stored?.lastError).toMatch(/^DRY_RUN_COMPLETE: /);
    expect(stored?.transactionId).toBeDefined();
    expect(stored?.stellarTxHash).toBeUndefined();
  });

  it("records every gate check result in the audit trail and never enters settling", async () => {
    const h = harness();
    await execute(intent("dry-2"), corridor(), h.deps, { dryRun: true });

    expect(h.audit.entries.map((e) => e.to)).toEqual([
      "quoted",
      "compliant",
      "opened",
      "verifying",
      "failed",
    ]);
    const names = ["anchor.drift", "chain.balance"];
    const verifying = h.audit.entries.find((e) => e.to === "verifying");
    expect(verifying?.checks?.map((c) => c.name)).toEqual(names);
    const terminal = h.audit.entries.find((e) => e.to === "failed");
    expect(terminal?.error).toMatch(/^DRY_RUN_COMPLETE: /);
    expect(terminal?.checks?.map((c) => c.name)).toEqual(names);
  });

  it("does not count against the corridor's circuit breaker", async () => {
    const h = harness();
    for (const key of ["dry-b1", "dry-b2", "dry-b3", "dry-b4"]) {
      await execute(intent(key), corridor(), h.deps, { dryRun: true });
    }
    const row = await h.health.get("test");
    expect(row?.state ?? "closed").toBe("closed");
    expect(row?.consecutiveFailures ?? 0).toBe(0);
  });

  it("ends with the gate's own refusal when a check fails", async () => {
    const h = harness({
      evaluate: async () => ({
        passed: false,
        results: [
          {
            name: "chain.balance",
            passed: false,
            detail: "balance too low",
            code: "PRESETTLE_INSUFFICIENT_FUNDS",
            durationMs: 1,
          },
        ],
      }),
    });
    const r = await execute(intent("dry-3"), corridor(), h.deps, { dryRun: true });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
    expect(h.calls.submit).toBe(0);
    const verifying = h.audit.entries.find((e) => e.to === "verifying");
    expect(verifying?.checks?.[0]).toMatchObject({ name: "chain.balance", passed: false });
  });

  it("spends the idempotency key so a later real run cannot reuse it", async () => {
    const h = harness();
    await execute(intent("dry-4"), corridor(), h.deps, { dryRun: true });
    const replay = await execute(intent("dry-4"), corridor(), h.deps);

    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(h.calls.submit).toBe(0);
  });

  it("still stops before settling when the gate is explicitly skipped", async () => {
    const h = harness();
    const { gate: _gate, ...rest } = h.deps;
    const r = await execute(
      intent("dry-5"),
      corridor(),
      { ...rest, unsafeSkipPreSettleGate: true },
      { dryRun: true },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("DRY_RUN_COMPLETE");
    expect(h.calls.submit).toBe(0);
    const verifying = h.audit.entries.find((e) => e.to === "verifying");
    expect(verifying?.checks?.[0].name).toBe("gate.skipped");
  });
});

describe("SettlementStrategy", () => {
  // Helper: run a full payment through execute() with custom deps override.
  async function run(depsOverride: Partial<EngineDeps> = {}) {
    return execute(intent("strategy-test"), corridor(), {
      ...deps(),
      ...depsOverride,
      idempotency: new InMemoryIdempotencyStore(),
    });
  }

  it("StellarPaymentStrategy produces the same settling -> settled transition as the legacy submitter", async () => {
    const submitter = createMockSubmitter();
    const r = await run({
      strategies: [new StellarPaymentStrategy(submitter)],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.trail).toContain("settling");
      expect(r.value.trail).toContain("settled");
      expect(r.value.stellarTxHash).toMatch(/^mocktx/);
    }
  });

  it("strategy selected by kind: engine dispatches to the matching strategy", async () => {
    // Spy to verify the correct strategy's settle() was called.
    const spySettle = vi.fn().mockResolvedValue(
      ok({
        kind: "stellar",
        stellarTxHash: "spy000000000000000000000000000000000000000000000000000000000001",
        ledger: 1,
      }),
    );
    const strategy: SettlementStrategy = {
      kind: "stellar_payment",
      settle: spySettle,
    };

    const r = await run({ strategies: [strategy] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.state).toBe("completed");
    expect(spySettle).toHaveBeenCalledOnce();
    // Context should carry the opened tx, quote, and corridor.
    const ctx = spySettle.mock.calls[0][0];
    expect(ctx).toHaveProperty("opened");
    expect(ctx).toHaveProperty("quote");
    expect(ctx).toHaveProperty("corridor");
  });

  it("unknown kind fails closed and never calls the submitter", async () => {
    const submitter = createMockSubmitter();
    const submitSpy = vi.spyOn(submitter, "submit");

    // Create an adapter that returns a deposit instruction kind not in our
    // strategies list, simulating a future kind from issue #183.
    const mockAdapter = createMockAdapter();
    const originalOpen = mockAdapter.openTransaction.bind(mockAdapter);
    mockAdapter.openTransaction = async (intent, quote, corridor) => {
      const r = await originalOpen(intent, quote, corridor);
      if (!r.ok) return r;
      // Return a claimable_balance deposit instruction.
      return ok<OpenTransaction>({
        ...r.value,
        instructions: {
          kind: "claimable_balance",
          claimant: "GCLAIMANT000000000000000000000000000000000000000000000000",
        },
      });
    };

    const resolver = new StaticRouteResolver(() => mockAdapter, {
      trustManifestWithoutAttestation: true,
    });

    // Only register a stellar_payment strategy — no match for claimable_balance.
    const r = await run({
      resolver,
      submitter,
      strategies: [new StellarPaymentStrategy(submitter)],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_FAILED");
      // The error message must name the unrecognised kind.
      expect(r.error.message).toMatch(/claimable_balance/);
    }
    // The underlying submitter must not have been called — no money moved.
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("settling -> settled transitions are unchanged when using strategies", async () => {
    const audit = new InMemoryAuditLog();
    const r = await run({
      strategies: [new StellarPaymentStrategy(createMockSubmitter())],
    });
    void audit;
    expect(r.ok).toBe(true);
    if (r.ok) {
      const trail = r.value.trail;
      const settlingIdx = trail.indexOf("settling");
      const settledIdx = trail.indexOf("settled");
      expect(settlingIdx).toBeGreaterThan(-1);
      expect(settledIdx).toBe(settlingIdx + 1);
    }
  });
});

describe("path-payment settlement selection (#217)", () => {
  const BRIDGE_ISSUER = Keypair.random().publicKey();
  const RECV_ISSUER = Keypair.random().publicKey();
  const DEPOSIT = Keypair.random().publicKey();

  function pathCorridor(): Corridor {
    const base = corridor();
    const r = parseCorridor({
      ...base,
      settlement: {
        ...base.settlement,
        asset_issuer: BRIDGE_ISSUER,
        receive_asset: "ARSX",
        receive_asset_issuer: RECV_ISSUER,
      },
    });
    if (!r.ok) throw new Error("fixture invalid");
    return r.value;
  }

  /** A real StellarPathPaymentStrategy over a fake Horizon with one 99.9 ARSX path. */
  function pathStrategy() {
    const submitted: Transaction[] = [];
    const strictSendPaths = vi.fn(() => ({
      call: async () => ({ records: [{ destination_amount: "99.9000000", path: [] }] }),
    }));
    const server = {
      loadAccount: async (id: string) => new Account(id, "100"),
      submitTransaction: async (tx: Transaction) => {
        submitted.push(tx);
        return { successful: true };
      },
      strictSendPaths,
      transactions: () => ({
        transaction: () => ({ call: async () => ({ successful: true, ledger_attr: 7 }) }),
      }),
    } as unknown as Horizon.Server;
    const strategy = new StellarPathPaymentStrategy(
      new StellarSettlementSubmitter({
        signerSecret: Keypair.random().secret(),
        horizonUrl: "unused",
        horizonServer: server,
        allowedNetworks: ["public"],
        allowLocalSignerOnMainnet: true,
      }),
    );
    return { strategy, strictSendPaths, submitted };
  }

  function pathDeps() {
    const submitter = createMockSubmitter();
    const submit = vi.spyOn(submitter, "submit");
    const d: EngineDeps = {
      ...deps({ instructions: { kind: "stellar_payment", to: DEPOSIT, memo: "m-1" } }),
      submitter,
    };
    return { d, submitter, submit };
  }

  it("selects StellarPathPaymentStrategy when receive_asset differs from bridge_asset", async () => {
    const path = pathStrategy();
    const { d, submitter, submit } = pathDeps();
    const r = await execute(intent("path-select"), pathCorridor(), {
      ...d,
      // Plain strategy listed first: it must decline, not pay the bridge asset.
      strategies: [new StellarPaymentStrategy(submitter), path.strategy],
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.state).toBe("completed");
    expect(submit).not.toHaveBeenCalled();
    expect(path.strictSendPaths).toHaveBeenCalledOnce();
    expect(path.submitted).toHaveLength(1);
    const op = path.submitted[0]!.operations[0]!;
    expect(op.type).toBe("pathPaymentStrictSend");
    if (op.type === "pathPaymentStrictSend") {
      expect(op.destination).toBe(DEPOSIT);
      expect(op.sendAmount).toBe("100.0000000");
      expect(op.destAsset.getCode()).toBe("ARSX");
      // 99.9 × (1 - 50 bps) = 99.4005
      expect(op.destMin).toBe("99.4005000");
    }
  });

  it("keeps the plain payment strategy when the corridor has no differing receive_asset", async () => {
    const path = pathStrategy();
    const { d, submitter, submit } = pathDeps();
    const r = await execute(intent("path-select-same"), corridor(), {
      ...d,
      strategies: [path.strategy, new StellarPaymentStrategy(submitter)],
    });

    expect(r.ok).toBe(true);
    expect(submit).toHaveBeenCalledOnce();
    expect(path.strictSendPaths).not.toHaveBeenCalled();
    expect(path.submitted).toHaveLength(0);
  });

  it("fails closed without paying the bridge asset when no path strategy is wired", async () => {
    const { d, submit } = pathDeps();
    const r = await execute(intent("path-missing"), pathCorridor(), d);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_FAILED");
      expect(r.error.message).toMatch(/ARSX/);
    }
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("circuit breaker x refund_pending", () => {
  // Decision: a lane failure is counted when the run RESOLVES (refunded / held),
  // with the original settlement/reconcile cause -- not when it parks in
  // refund_pending, which is still in flight.
  function harness(adapterOpts: Parameters<typeof createMockAdapter>[0]) {
    const health = new InMemoryCorridorHealthStore();
    const seenWhilePending: number[] = [];
    const store = new InMemoryIdempotencyStore();
    const base = createMockSubmitter();
    let t = 0;
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: base,
      idempotency: store,
      health,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        // The refund watch sleeps between polls, i.e. while the run is parked in
        // refund_pending: record what the breaker has counted at that moment.
        if ((await store.get("bp-1"))?.state === "refund_pending") {
          seenWhilePending.push((await health.get("test"))?.consecutiveFailures ?? 0);
        }
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    return { deps, health, store, seenWhilePending };
  }

  const recovery = {
    max_retries: 0,
    timeout_seconds: 3600,
    refund_wait_seconds: 1,
    rollback: "refund_sender",
  };

  it("counts a recovering -> refund_pending -> refunded run exactly once", async () => {
    const h = harness({
      terminalFailure: true,
      refundStatus: {
        amountRefunded: { asset: "USDC", amount: "100.00" },
        amountFee: { asset: "USDC", amount: "0.00" },
        payments: [
          {
            id: "refund-1",
            amount: { asset: "USDC", amount: "100.00" },
            fee: { asset: "USDC", amount: "0.00" },
          },
        ],
        completeness: "full",
      },
    });
    const r = await execute(intent("bp-1"), corridorWith(recovery), h.deps);
    expect(r.ok).toBe(false);
    expect((await h.store.get("bp-1"))?.state).toBe("refunded");
    const row = await h.health.get("test");
    expect(row?.consecutiveFailures).toBe(1);
    expect(row?.lastError).toContain("RECONCILE_MISMATCH");
  });

  it("counts a refund_pending -> held run exactly once, and not while it sits in refund_pending", async () => {
    const h = harness({ terminalFailure: true });
    const r = await execute(intent("bp-1"), corridorWith(recovery), h.deps);
    expect(r.ok).toBe(false);
    expect((await h.store.get("bp-1"))?.state).toBe("held");
    // The watch really did sit in refund_pending, and nothing was counted yet.
    expect(h.seenWhilePending.length).toBeGreaterThan(0);
    expect(h.seenWhilePending.every((n) => n === 0)).toBe(true);
    const row = await h.health.get("test");
    expect(row?.consecutiveFailures).toBe(1);
    // The breaker judges the ORIGINAL reconcile cause, not the watch timeout.
    expect(row?.lastError).toContain("RECONCILE_MISMATCH");
  });
});

describe("circuit breaker x resumed recovery", () => {
  // After a restart the failure that sent a run into recovery is gone from
  // memory, but its persisted `lastError` is not. The breaker should judge that
  // real cause, and fall back to the refunded-reconcile error only when there is
  // no lane-failure cause to read back (so a resume is never more lenient).
  const recovery = {
    max_retries: 0,
    timeout_seconds: 3600,
    refund_wait_seconds: 1,
    rollback: "refund_sender",
  };
  const refundStatus = {
    amountRefunded: { asset: "USDC", amount: "100.00" },
    amountFee: { asset: "USDC", amount: "0.00" },
    payments: [
      {
        id: "refund-1",
        amount: { asset: "USDC", amount: "100.00" },
        fee: { asset: "USDC", amount: "0.00" },
      },
    ],
    completeness: "full" as const,
  };

  function resumeHarness(adapterOpts: Parameters<typeof createMockAdapter>[0]) {
    const health = new InMemoryCorridorHealthStore();
    const store = new InMemoryIdempotencyStore();
    let t = 0;
    const deps: EngineDeps = {
      resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: store,
      health,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };
    return { deps, health, store };
  }

  it.each(["recovering", "refund_pending"] as const)(
    "a %s run resumed to refunded is judged by its persisted lane-failure cause",
    async (state) => {
      const h = resumeHarness({ terminalFailure: true, refundStatus });
      const key = `rr-${state}`;
      await h.store.put({
        ...resumableRun(state, key),
        lastError: "RECONCILE_STALLED: anchor stopped reporting",
      });
      const r = await execute(intent(key), corridorWith(recovery), h.deps);
      expect(r.ok).toBe(false);
      expect((await h.store.get(key))?.state).toBe("refunded");
      const row = await h.health.get("test");
      expect(row?.consecutiveFailures).toBe(1);
      expect(row?.lastError).toContain("RECONCILE_STALLED: anchor stopped reporting");
      expect(row?.lastError).not.toContain("was refunded");
    },
  );

  it("a resumed run that ends held is judged by its persisted cause, not the watch timeout", async () => {
    const h = resumeHarness({ terminalFailure: true });
    const key = "rr-held";
    await h.store.put({
      ...resumableRun("refund_pending", key),
      lastError: "SETTLEMENT_TIMEOUT: anchor never confirmed",
    });
    const r = await execute(intent(key), corridorWith(recovery), h.deps);
    expect(r.ok).toBe(false);
    expect((await h.store.get(key))?.state).toBe("held");
    const row = await h.health.get("test");
    expect(row?.consecutiveFailures).toBe(1);
    expect(row?.lastError).toContain("SETTLEMENT_TIMEOUT: anchor never confirmed");
  });

  it.each([
    ["a neutral code", "REFUND_UNSUPPORTED: the refund port refused"],
    ["no lastError at all", undefined],
    ["a lastError that is not CODE: message", "something went wrong"],
  ] as const)(
    "falls back to the refunded-reconcile cause for %s",
    async (_label, lastError) => {
      const h = resumeHarness({ terminalFailure: true, refundStatus });
      const key = "rr-fallback";
      await h.store.put({ ...resumableRun("refund_pending", key), lastError });
      const r = await execute(intent(key), corridorWith(recovery), h.deps);
      expect(r.ok).toBe(false);
      const row = await h.health.get("test");
      // Still counted exactly once, exactly as before this change.
      expect(row?.consecutiveFailures).toBe(1);
      expect(row?.lastError).toContain("RECONCILE_MISMATCH");
    },
  );
});

describe("engine adapter capabilities compatibility (#188)", () => {
  it("fails with CAPABILITY_MISMATCH when adapter reports quotes: ['none'] on quote_source: sep38 corridor before any other adapter call", async () => {
    let quoteCalled = false;
    let complyCalled = false;
    let openCalled = false;
    const adapter = createMockAdapter({
      capabilities: { quotes: ["none"] },
    });
    const originalQuote = adapter.requestQuote.bind(adapter);
    adapter.requestQuote = async (...args) => {
      quoteCalled = true;
      return originalQuote(...args);
    };
    adapter.ensureCompliance = async () => {
      complyCalled = true;
      return ok({ status: "accepted", customerId: "mock" });
    };
    adapter.openTransaction = async () => {
      openCalled = true;
      return ok({
        transactionId: "mock",
        instructions: { kind: "stellar_payment", to: "G...", memo: "memo" },
      });
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent("cap-quotes-none"), corridor(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CAPABILITY_MISMATCH");
    }
    expect(quoteCalled).toBe(false);
    expect(complyCalled).toBe(false);
    expect(openCalled).toBe(false);
  });

  it("fails before open when settlement kind is not covered by strategies", async () => {
    let openCalled = false;
    const adapter = createMockAdapter({
      capabilities: { settlement: ["claimable_balance"] },
    });
    adapter.openTransaction = async () => {
      openCalled = true;
      return ok({
        transactionId: "mock",
        instructions: { kind: "stellar_payment", to: "G...", memo: "memo" },
      });
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent("cap-settlement-uncovered"), corridor(), d);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("CAPABILITY_MISMATCH");
    }
    expect(openCalled).toBe(false);
  });

  it("skips comply when caps.kyc === 'none' without calling ensureCompliance", async () => {
    let complyCalled = false;
    const adapter = createMockAdapter({
      capabilities: { kyc: "none" },
    });
    adapter.ensureCompliance = async () => {
      complyCalled = true;
      return ok({ status: "accepted", customerId: "mock" });
    };

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter: createMockSubmitter(),
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent("cap-kyc-none"), corridor(), d);
    expect(r.ok).toBe(true);
    expect(complyCalled).toBe(false);
    if (r.ok) {
      expect(r.value.state).toBe("completed");
      expect(r.value.trail).toContain("compliant");
    }
  });
});

describe("adapter-reported (off-chain) settlement (#186)", () => {
  it("mock adapter with adapter_settled instructions reaches completed with no submitter call", async () => {
    let submitCalled = false;
    let findExistingCalled = false;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalled = true;
        return ok({ kind: "stellar", stellarTxHash: "stellar-tx-should-not-be-called" });
      },
      async findExisting() {
        findExistingCalled = true;
        return ok(undefined);
      },
      async refund() {
        return fail("SETTLEMENT_FAILED", "not reached", { retryable: false });
      },
    };

    const confirmSettlementSpy = vi.fn().mockResolvedValue(
      ok({
        kind: "adapter" as const,
        reference: "otc_ref_98765",
        reportedAt: 1700000000000,
      }),
    );

    const adapter = createMockAdapter({
      instructions: { kind: "adapter_settled", reference: "otc_ref_98765" },
    });
    adapter.confirmSettlement = confirmSettlementSpy;

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: new InMemoryIdempotencyStore(),
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent("adapter-settled-1"), corridor(), d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.state).toBe("completed");
    expect(r.value.settlementKind).toBe("adapter");
    expect(r.value.settlementRef).toEqual({
      kind: "adapter",
      reference: "otc_ref_98765",
      reportedAt: 1700000000000,
    });
    expect(r.value.stellarTxHash).toBeUndefined();
    expect(confirmSettlementSpy).toHaveBeenCalledOnce();
    expect(submitCalled).toBe(false);
    expect(findExistingCalled).toBe(false);
  });

  it("resume from settled with an adapter settlement ref re-polls and does not re-settle", async () => {
    let submitCalled = false;
    let findExistingCalled = false;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalled = true;
        return ok({ kind: "stellar", stellarTxHash: "should-not-be-called" });
      },
      async findExisting() {
        findExistingCalled = true;
        return ok(undefined);
      },
      async refund() {
        return fail("SETTLEMENT_FAILED", "not reached", { retryable: false });
      },
    };

    const confirmSettlementSpy = vi.fn().mockResolvedValue(
      ok({
        kind: "adapter" as const,
        reference: "ref_confirm_should_not_be_called",
        reportedAt: Date.now(),
      }),
    );

    const adapter = createMockAdapter();
    adapter.confirmSettlement = confirmSettlementSpy;
    let pollCount = 0;
    const origGetTransaction = adapter.getTransaction.bind(adapter);
    adapter.getTransaction = async (txId) => {
      pollCount++;
      return origGetTransaction(txId);
    };

    const store = new InMemoryIdempotencyStore();
    const key = "resume-adapter-settled";
    await store.put({
      idempotencyKey: key,
      corridorId: "test",
      state: "settled",
      version: 4,
      transactionId: "tx_adapter_resume",
      quoteId: "q_adapter_resume",
      quoteExpiresAt: Date.now() + 60_000,
      quoteFirm: true,
      settlementAmount: "100.00",
      settlementKind: "adapter",
      settlementRef: {
        kind: "adapter",
        reference: "otc_ref_existing",
        reportedAt: 1600000000000,
      },
    });

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: store,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(intent(key), corridor(), d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.value.state).toBe("completed");
    expect(r.value.settlementKind).toBe("adapter");
    expect(r.value.settlementRef).toEqual({
      kind: "adapter",
      reference: "otc_ref_existing",
      reportedAt: 1600000000000,
    });
    expect(r.value.stellarTxHash).toBeUndefined();

    // Re-polled via getTransaction
    expect(pollCount).toBeGreaterThanOrEqual(1);
    // Did NOT re-settle:
    expect(confirmSettlementSpy).not.toHaveBeenCalled();
    expect(submitCalled).toBe(false);
    expect(findExistingCalled).toBe(false);

    const persisted = await store.get(key);
    expect(persisted?.state).toBe("completed");
    expect(persisted?.settlementKind).toBe("adapter");
    expect(persisted?.settlementRef).toEqual({
      kind: "adapter",
      reference: "otc_ref_existing",
      reportedAt: 1600000000000,
    });
  });

  it("failure after an adapter settlement ends in held, not refunded", async () => {
    let t = 0;
    const adapter = createMockAdapter({
      settled: false,
      instructions: { kind: "adapter_settled", reference: "otc_ref_fail" },
      confirmSettlementResult: ok({
        kind: "adapter",
        reference: "otc_ref_fail",
        reportedAt: 1700000000000,
      }),
    });
    let submitCalled = false;
    let refundCalled = false;
    const submitter: SettlementSubmitter = {
      async submit() {
        submitCalled = true;
        return fail("SETTLEMENT_FAILED", "unexpected submit", { retryable: false });
      },
      async refund() {
        refundCalled = true;
        return fail("SETTLEMENT_FAILED", "unexpected refund", { retryable: false });
      },
    };
    const store = new InMemoryIdempotencyStore();
    const audit = new InMemoryAuditLog();
    const key = "adapter-settled-timeout";

    const d: EngineDeps = {
      resolver: new StaticRouteResolver(() => adapter, {
        trustManifestWithoutAttestation: true,
      }),
      submitter,
      idempotency: store,
      audit,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      reconcilePollMs: 500,
      trustManifestWithoutAttestation: true,
      unsafeSkipPreSettleGate: true,
    };

    const r = await execute(
      intent(key),
      corridorWith({ max_retries: 0, timeout_seconds: 1, rollback: "refund_sender" }),
      d,
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REFUND_UNSUPPORTED");
    }

    const persisted = await store.get(key);
    expect(persisted?.state).toBe("held");
    expect(persisted?.state).not.toBe("refunded");
    expect(persisted?.settlementKind).toBe("adapter");
    expect(persisted?.settlementRef).toEqual({
      kind: "adapter",
      reference: "otc_ref_fail",
      reportedAt: expect.any(Number),
    });
    expect(persisted?.lastError).toContain("REFUND_UNSUPPORTED");

    // The audit trail confirms we stepped into recovering, then held (not refunded)
    const trail = audit.entries.map((e) => e.to);
    expect(trail).toContain("settled");
    expect(trail).toContain("recovering");
    expect(trail).toContain("held");
    expect(trail).not.toContain("refunded");

    // No submitter calls were made
    expect(submitCalled).toBe(false);
    expect(refundCalled).toBe(false);
  });
});
