import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Networks,
  NotFoundError,
  Operation,
  Transaction,
  TransactionBuilder,
  TransactionFailedError,
} from "@stellar/stellar-sdk";
import {
  AccountInspector,
  balanceCheck,
  destinationCheck,
  createChainVerifier,
  verifySettlementFacts,
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
  type AccountFacts,
  type HorizonAccountResponseLike,
  type ExternalSigner,
  type SettlementFacts,
} from "@corridor/stellar";
import type { GateContext, RefundRequest, SettlementRequest } from "@corridor/engine";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { Horizon } from "@stellar/stellar-sdk";

function challengeXdr(kp: Keypair): string {
  return new TransactionBuilder(new Account(kp.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: "1" }),
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

describe("LocalKeypairSigner", () => {
  it("produces a signature the keypair verifies", async () => {
    const kp = Keypair.random();
    const signer = new LocalKeypairSigner(kp);
    expect(signer.publicKey).toBe(kp.publicKey());
    const data = Buffer.from("0123456789abcdef0123456789abcdef"); // 32 bytes
    const sig = await signer.sign(data);
    expect(kp.verify(data, Buffer.from(sig))).toBe(true);
  });
});

describe("StellarSep10Signer", () => {
  it("signs a challenge with a raw Keypair", async () => {
    const kp = Keypair.random();
    const signer = new StellarSep10Signer(kp);
    expect(signer.account).toBe(kp.publicKey());

    const signedXdr = await signer.signChallenge(challengeXdr(kp), Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(signed.signatures.length).toBe(1);
    // the attached signature must verify against the signer's key over the tx hash
    expect(
      kp.verify(signed.hash(), Buffer.from(signed.signatures[0].signature.toBytes())),
    ).toBe(true);
  });

  it("works through the ExternalSigner port (KMS-style)", async () => {
    const kp = Keypair.random();
    // A signer that only exposes publicKey + sign — no Keypair leaking through.
    const external: ExternalSigner = {
      publicKey: kp.publicKey(),
      sign: async (data) => kp.sign(Buffer.from(data)),
    };
    const signer = new StellarSep10Signer(external);
    const signedXdr = await signer.signChallenge(challengeXdr(kp), Networks.TESTNET);
    const signed = TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET);
    expect(
      kp.verify(signed.hash(), Buffer.from(signed.signatures[0].signature.toBytes())),
    ).toBe(true);
  });
});

describe("StellarSettlementSubmitter", () => {
  // The refusal is by design, not a settlement outage: it must report under its
  // own code so paging on SETTLEMENT_FAILED doesn't fire on a design invariant.
  it("refuses to reverse a settled payment on-chain (escalates to manual)", async () => {
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "https://horizon-testnet.stellar.org",
    });
    const req = {
      original: { stellarTxHash: "deadbeef" },
      amount: { asset: "USDC", amount: "1" },
      reason: "test",
    } as unknown as RefundRequest;

    const r = await sub.refund(req);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("REFUND_UNSUPPORTED");
      expect(r.error.retryable).toBe(false);
      expect(r.error.message).toContain("cannot be reversed on-chain");
    }
  });
});

// --- submit() ambiguous-failure safety ------------------------------------
// A client-side network error from submitTransaction() does not mean the
// payment failed — Horizon may have applied it anyway. Blindly retrying that
// case builds and sends an independently-valid second payment. These tests
// pin the fix: only a CONFIRMED Horizon rejection (TransactionFailedError) is
// retryable; anything else must be resolved via confirm()-by-hash before a
// retryable/non-retryable verdict is returned.

const ISSUER = Keypair.random().publicKey();

function testCorridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "testnet", asset_issuer: ISSUER },
    recovery: { max_retries: 2 },
  });
  if (!r.ok) throw new Error(`fixture invalid: ${JSON.stringify(r.error)}`);
  return r.value;
}

function testRequest(): SettlementRequest {
  return {
    to: Keypair.random().publicKey(),
    amount: { asset: "USDC", amount: "10" },
    corridor: testCorridor(),
  };
}

/** A minimal fake Horizon server: only the three methods submit() touches. */
function fakeServer(opts: {
  submitTransaction: (tx?: Transaction | FeeBumpTransaction) => Promise<unknown>;
  lookupTransaction?: (hash: string) => Promise<{ successful: boolean; ledger_attr?: number }>;
}) {
  const loadAccount = vi.fn(async (publicKey: string) => new Account(publicKey, "100"));
  const submitTransaction = vi.fn(opts.submitTransaction);
  const lookupTransaction =
    opts.lookupTransaction ??
    (async () => {
      throw new Error("not found");
    });
  return {
    loadAccount,
    submitTransaction,
    transactions: () => ({
      transaction: (hash: string) => ({ call: () => lookupTransaction(hash) }),
    }),
  } as unknown as Horizon.Server;
}

function immediateClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("StellarSettlementSubmitter.submit — ambiguous failure safety", () => {
  it("a confirmed Horizon rejection (TransactionFailedError) is retryable", async () => {
    const rejection = new TransactionFailedError("tx failed", {
      data: { extras: { result_codes: { transaction: "tx_bad_seq", operations: [] } } },
    });
    const server = fakeServer({
      submitTransaction: async () => {
        throw rejection;
      },
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
    });

    const r = await sub.submit(testRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_FAILED");
      expect(r.error.retryable).toBe(true);
    }
  });

  it("an ambiguous failure whose tx actually landed resolves to ok, not a retry", async () => {
    const server = fakeServer({
      submitTransaction: async () => {
        throw new Error("ECONNRESET");
      },
      lookupTransaction: async () => ({ successful: true, ledger_attr: 4_242 }),
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
      ...immediateClock(),
    });

    const r = await sub.submit(testRequest());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.ledger).toBe(4_242);
    // Exactly one on-chain submission attempt — the fix must never resubmit
    // to resolve the ambiguity, only look the original tx up by hash.
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("an ambiguous failure that never resolves is non-retryable, not blindly retried", async () => {
    const server = fakeServer({
      submitTransaction: async () => {
        throw new Error("ECONNRESET");
      },
      // tx is never found — confirm() polls until its timeout.
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
      confirmTimeoutMs: 3_000,
      ...immediateClock(),
    });

    const r = await sub.submit(testRequest());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SETTLEMENT_TIMEOUT");
      // The whole point of the fix: an unresolved ambiguous failure must NOT
      // be marked safe to retry, or a caller-level retry double-pays.
      expect(r.error.retryable).toBe(false);
    }
    expect(server.submitTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("StellarSettlementSubmitter.submit — validUntil quote expiry timebounds", () => {
  it("built tx maxTime equals floor(validUntil/1000) when that is sooner than the TTL", async () => {
    let capturedTx: Transaction | FeeBumpTransaction | undefined;
    const server = fakeServer({
      submitTransaction: async (tx) => {
        capturedTx = tx;
        return { successful: true };
      },
      lookupTransaction: async () => ({ successful: true, ledger_attr: 1234 }),
    });

    const fakeNow = 1_000_000_000; // ms
    const quoteExpiresAt = fakeNow + 15_000; // 15s in future (sooner than 60s TTL)
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
      now: () => fakeNow,
    });

    const req = {
      ...testRequest(),
      validUntil: quoteExpiresAt,
    };

    const res = await sub.submit(req);
    expect(res.ok).toBe(true);
    expect(capturedTx).toBeDefined();
    if (capturedTx && "timeBounds" in capturedTx) {
      expect(capturedTx.timeBounds?.maxTime).toBe(String(Math.floor(quoteExpiresAt / 1000)));
    }
  });

  it("fails with QUOTE_EXPIRED and never calls submitTransaction when validUntil is in the past", async () => {
    const server = fakeServer({
      submitTransaction: async () => {
        throw new Error("should not be called");
      },
    });

    const fakeNow = 1_000_000_000; // ms
    const quoteExpiresAt = fakeNow - 1_000; // 1s in the past
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
      now: () => fakeNow,
    });

    const req = {
      ...testRequest(),
      validUntil: quoteExpiresAt,
    };

    const res = await sub.submit(req);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("QUOTE_EXPIRED");
      expect(res.error.retryable).toBe(false);
    }
    expect(server.submitTransaction).not.toHaveBeenCalled();
    expect(server.loadAccount).not.toHaveBeenCalled();
  });
});

describe("StellarSettlementSubmitter.submit — sequence-number serialization", () => {
  it("serializes concurrent submitTransaction calls (no two in flight together)", async () => {
    // External state, not an in-mock `expect()` — a throw inside the fake
    // would just be caught by submit()'s own try/catch and silently routed
    // into the ambiguous-failure path, hiding a real serialization bug.
    let inFlight = 0;
    let sawOverlap = false;
    const server = fakeServer({
      submitTransaction: async () => {
        inFlight++;
        if (inFlight > 1) sawOverlap = true;
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
      lookupTransaction: async () => ({ successful: true, ledger_attr: 1 }),
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
    });

    const [a, b] = await Promise.all([sub.submit(testRequest()), sub.submit(testRequest())]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(server.loadAccount).toHaveBeenCalledTimes(2);
    expect(server.submitTransaction).toHaveBeenCalledTimes(2);
    expect(sawOverlap).toBe(false);
  });

  it("releases the lock right after submitTransaction, not after the confirm() poll", async () => {
    const marks: Record<string, number> = {};
    let submitCount = 0;
    let confirmCount = 0;
    const server = fakeServer({
      submitTransaction: async () => {
        submitCount++;
        marks[`submit${submitCount}`] = performance.now();
      },
      lookupTransaction: async () => {
        confirmCount++;
        const n = confirmCount;
        // Long enough that "lock held through confirm" and "lock released
        // after submitTransaction" produce clearly distinguishable timing.
        await new Promise((r) => setTimeout(r, 40));
        marks[`confirmEnd${n}`] = performance.now();
        return { successful: true, ledger_attr: 1 };
      },
    });
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "unused",
      horizonServer: server,
    });

    await Promise.all([sub.submit(testRequest()), sub.submit(testRequest())]);

    // If the lock were (incorrectly) held through confirm(), the second
    // submitTransaction couldn't start until the first confirm() poll had
    // already finished — i.e. submit2 would land at or after confirmEnd1.
    // Releasing early lets submit2 start while confirm1 is still in flight.
    expect(marks.submit2).toBeLessThan(marks.confirmEnd1);
  });
});

describe("StellarSettlementSubmitter.fee", () => {
  it("exposes the default fee of 100 stroops (0.00001 XLM)", () => {
    expect(StellarSettlementSubmitter.fee).toBe("0.00001");
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "https://horizon-testnet.stellar.org",
    });
    expect(sub.fee).toBe("0.00001");
  });

  it("allows custom fee override in constructor", () => {
    const sub = new StellarSettlementSubmitter({
      signerSecret: Keypair.random().secret(),
      horizonUrl: "https://horizon-testnet.stellar.org",
      fee: "0.00002",
    });
    expect(sub.fee).toBe("0.00002");
  });

  it("throws at construction on an invalid fee instead of falling back", () => {
    expect(
      () =>
        new StellarSettlementSubmitter({
          signerSecret: Keypair.random().secret(),
          horizonUrl: "https://horizon-testnet.stellar.org",
          fee: "not-a-number",
        }),
    ).toThrow(/invalid `fee`/);
  });
});

describe("AccountInspector", () => {
  it("loads account facts and normalizes balances, liabilities and counts", async () => {
    const fakeAccount = {
      id: "GACCOUNT123",
      subentry_count: 5,
      num_sponsoring: 2,
      num_sponsored: 1,
      balances: [
        {
          asset_type: "native",
          balance: "100.5000000",
          selling_liabilities: "1.0000000",
          buying_liabilities: "0.5000000",
        },
        {
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: ISSUER,
          balance: "500.0000000",
          selling_liabilities: "50.0000000",
        },
      ],
    };
    const inspector = new AccountInspector({
      horizonServer: {
        loadAccount: async () => fakeAccount as unknown as Horizon.AccountResponse,
      },
    });

    const res = await inspector.account("GACCOUNT123");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value?.id).toBe("GACCOUNT123");
    expect(res.value?.subentry_count).toBe(5);
    expect(res.value?.num_sponsoring).toBe(2);
    expect(res.value?.num_sponsored).toBe(1);
    expect(res.value?.balances.length).toBe(2);
    expect(res.value?.balances[0].balance).toBe("100.5000000");
    expect(res.value?.balances[0].selling_liabilities).toBe("1.0000000");
  });

  it("returns ok(undefined) when account is 404", async () => {
    const inspector = new AccountInspector({
      horizonServer: {
        loadAccount: async () => {
          throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
        },
      },
    });

    const res = await inspector.account("GMISSING");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBeUndefined();
    }
  });

  it("exposes baseReserve and baseFee", async () => {
    const inspector = new AccountInspector({ baseReserve: "0.5", baseFee: "0.00001" });
    const reserve = await inspector.baseReserve();
    expect(reserve.ok).toBe(true);
    if (reserve.ok) expect(reserve.value).toBe("0.5");
    const fee = await inspector.baseFee();
    expect(fee.ok).toBe(true);
    if (fee.ok) expect(fee.value).toBe("0.00001");
  });
});

describe("AccountInspector against a fake Horizon", () => {
  const OURS = Keypair.random().publicKey();
  const DEST = Keypair.random().publicKey();
  const OTHER = Keypair.random().publicKey();

  interface FakePayment {
    id: string;
    type?: string;
    from?: string;
    to?: string;
    to_muxed?: string;
    amount?: string;
    ledger: number;
    memo_type?: "none" | "text" | "id" | "hash" | "return";
    memo?: string;
    /** Leave the joined transaction off, as a non-joined call would. */
    unjoined?: boolean;
  }

  /** Pages the fake payments `pageSize` at a time, newest first, like Horizon. */
  function fakeHorizon(
    opts: {
      account?: () => Promise<HorizonAccountResponseLike>;
      ledger?: {
        sequence: number;
        base_fee_in_stroops: number;
        base_reserve_in_stroops: number;
      };
      payments?: FakePayment[];
      paymentsError?: unknown;
    } = {},
  ) {
    const calls = { paymentsFor: [] as string[], joined: [] as string[], pagesRead: 0 };
    const record = (p: FakePayment) => ({
      id: p.id,
      type: p.type ?? "payment",
      created_at: "2026-09-30T00:00:00Z",
      transaction_hash: `hash-${p.id}`,
      from: p.from ?? OURS,
      to: p.to ?? DEST,
      ...(p.to_muxed && { to_muxed: p.to_muxed }),
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: ISSUER,
      amount: p.amount ?? "100.0000000",
      // Mirrors what the SDK's _parseRecord leaves behind for a joined
      // transaction: the raw number moved to ledger_attr, `ledger` a link fn.
      ...(!p.unjoined && {
        transaction_attr: {
          memo_type: p.memo_type ?? "none",
          ...(p.memo !== undefined && { memo: p.memo }),
          ledger: async () => ({}),
          ledger_attr: p.ledger,
        },
      }),
    });
    type FakePage = { records: ReturnType<typeof record>[]; next: () => Promise<FakePage> };
    const server = {
      loadAccount: async (id: string) => {
        if (opts.account) return opts.account();
        throw new NotFoundError(`account ${id} not found`, {});
      },
      ledgers: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({
              records: opts.ledger ? [opts.ledger] : [],
              next: async () => ({ records: [], next: async () => never() }),
            }),
          }),
        }),
      }),
      payments: () => ({
        forAccount: (id: string) => {
          calls.paymentsFor.push(id);
          return {
            join: (include: "transactions") => {
              calls.joined.push(include);
              return {
                order: () => ({
                  limit: (n: number) => ({
                    call: async () => {
                      if (opts.paymentsError) throw opts.paymentsError;
                      const all = opts.payments ?? [];
                      const pageAt = (i: number): FakePage => {
                        calls.pagesRead += 1;
                        return {
                          records: all.slice(i, i + n).map(record),
                          next: async () => pageAt(i + n),
                        };
                      };
                      return pageAt(0);
                    },
                  }),
                }),
              };
            },
          };
        },
      }),
    };
    return { server, calls };
  }
  function never(): never {
    throw new Error("unexpected call");
  }

  describe("account()", () => {
    it("returns an existing account's balances, counts and flags", async () => {
      const { server } = fakeHorizon({
        account: async () => ({
          id: DEST,
          subentry_count: 3,
          num_sponsoring: 1,
          num_sponsored: 2,
          flags: { auth_required: true, auth_revocable: false },
          balances: [
            { asset_type: "native", balance: "12.5000000", selling_liabilities: "0.5000000" },
          ],
        }),
      });
      const res = await new AccountInspector({ horizonServer: server }).account(DEST);
      expect(res).toEqual({
        ok: true,
        value: {
          id: DEST,
          subentry_count: 3,
          num_sponsoring: 1,
          num_sponsored: 2,
          flags: { auth_required: true, auth_revocable: false },
          balances: [
            {
              asset_type: "native",
              asset_code: undefined,
              asset_issuer: undefined,
              balance: "12.5000000",
              selling_liabilities: "0.5000000",
              buying_liabilities: "0",
              is_authorized: true,
            },
          ],
        },
      });
    });

    it("returns ok(undefined) for the SDK's NotFoundError (404)", async () => {
      const { server } = fakeHorizon();
      const res = await new AccountInspector({ horizonServer: server }).account(DEST);
      expect(res).toEqual({ ok: true, value: undefined });
    });

    it("reports authorized and unauthorized trustlines as Horizon gives them", async () => {
      const { server } = fakeHorizon({
        account: async () => ({
          balances: [
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: ISSUER,
              balance: "10.0000000",
              is_authorized: true,
            },
            {
              asset_type: "credit_alphanum4",
              asset_code: "EURC",
              asset_issuer: ISSUER,
              balance: "0.0000000",
              is_authorized: false,
            },
          ],
        }),
      });
      const res = await new AccountInspector({ horizonServer: server }).account(DEST);
      if (!res.ok || !res.value) throw new Error("expected an account");
      const auth = Object.fromEntries(
        res.value.balances.map((b) => [b.asset_code, b.is_authorized]),
      );
      expect(auth).toEqual({ USDC: true, EURC: false });
    });

    it("never reads a trustline with unknown authorization as authorized", async () => {
      const { server } = fakeHorizon({
        account: async () => ({
          balances: [
            {
              asset_type: "credit_alphanum4",
              asset_code: "USDC",
              asset_issuer: ISSUER,
              balance: "1",
            },
          ],
        }),
      });
      const res = await new AccountInspector({ horizonServer: server }).account(DEST);
      if (!res.ok || !res.value) throw new Error("expected an account");
      expect(res.value.balances[0]!.is_authorized).toBe(false);
    });

    it("fails retryably when Horizon errors, even if the message says 'not found'", async () => {
      const { server } = fakeHorizon({
        account: async () => {
          throw Object.assign(new Error("upstream route not found"), {
            response: { status: 502 },
          });
        },
      });
      const res = await new AccountInspector({ horizonServer: server }).account(DEST);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("SETTLEMENT_FAILED");
      expect(res.error.retryable).toBe(true);
    });
  });

  describe("baseReserve() / baseFee()", () => {
    it("reads both from the latest ledger and converts stroops to XLM strings", async () => {
      const { server } = fakeHorizon({
        ledger: { sequence: 42, base_fee_in_stroops: 100, base_reserve_in_stroops: 5000000 },
      });
      const inspector = new AccountInspector({ horizonServer: server });
      expect(await inspector.baseReserve()).toEqual({ ok: true, value: "0.5" });
      expect(await inspector.baseFee()).toEqual({ ok: true, value: "0.00001" });
    });

    it("fails rather than guessing when the ledger's values are malformed or missing", async () => {
      const bad = fakeHorizon({
        ledger: {
          sequence: 42,
          base_fee_in_stroops: 100.5,
          base_reserve_in_stroops: "5e6" as unknown as number,
        },
      });
      const inspector = new AccountInspector({ horizonServer: bad.server });
      expect((await inspector.baseReserve()).ok).toBe(false);
      expect((await inspector.baseFee()).ok).toBe(false);

      const empty = new AccountInspector({ horizonServer: fakeHorizon().server });
      expect((await empty.baseReserve()).ok).toBe(false);
    });
  });

  describe("paymentsFrom()", () => {
    it("returns our outgoing payments joined with their transaction's memo", async () => {
      const { server, calls } = fakeHorizon({
        payments: [
          { id: "3", ledger: 30, memo_type: "text", memo: "tx-abc", amount: "25.0000000" },
          { id: "2", ledger: 20, memo_type: "hash", memo: "q83vEjRWeJA=" },
          { id: "1", ledger: 10 },
        ],
      });
      const res = await new AccountInspector({ horizonServer: server }).paymentsFrom(OURS);

      expect(calls.paymentsFor).toEqual([OURS]);
      expect(calls.joined).toEqual(["transactions"]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.truncated).toBe(false);
      expect(res.value.payments).toHaveLength(3);
      expect(res.value.payments[0]).toEqual({
        id: "3",
        type: "payment",
        transactionHash: "hash-3",
        ledger: 30,
        createdAt: "2026-09-30T00:00:00Z",
        from: OURS,
        to: DEST,
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        amount: "25.0000000",
        memoType: "text",
        memo: "tx-abc",
      });
      expect(res.value.payments.map((p) => [p.memoType, p.memo])).toEqual([
        ["text", "tx-abc"],
        ["hash", "q83vEjRWeJA="],
        ["none", undefined],
      ]);
    });

    it("drops incoming payments and non-payment operations", async () => {
      const { server } = fakeHorizon({
        payments: [
          { id: "4", ledger: 40, from: OTHER, to: OURS },
          { id: "3", ledger: 30, type: "create_account" },
          { id: "2", ledger: 20, type: "path_payment_strict_send" },
          { id: "1", ledger: 10 },
        ],
      });
      const res = await new AccountInspector({ horizonServer: server }).paymentsFrom(OURS);
      if (!res.ok) throw new Error(res.error.message);
      expect(res.value.payments.map((p) => [p.id, p.type])).toEqual([
        ["2", "path_payment_strict_send"],
        ["1", "payment"],
      ]);
    });

    it("filters by destination, matching a muxed address too", async () => {
      const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ";
      const { server } = fakeHorizon({
        payments: [
          { id: "3", ledger: 30, to: OTHER },
          { id: "2", ledger: 20, to: DEST, to_muxed: muxed },
          { id: "1", ledger: 10, to: DEST },
        ],
      });
      const inspector = new AccountInspector({ horizonServer: server });
      const byG = await inspector.paymentsFrom(OURS, { to: DEST });
      const byM = await inspector.paymentsFrom(OURS, { to: muxed });
      if (!byG.ok || !byM.ok) throw new Error("expected ok");
      expect(byG.value.payments.map((p) => p.id)).toEqual(["2", "1"]);
      expect(byM.value.payments.map((p) => p.id)).toEqual(["2"]);
      expect(byM.value.payments[0]!.toMuxed).toBe(muxed);
    });

    it("stops paging at sinceLedger and reports the history as complete", async () => {
      const { server, calls } = fakeHorizon({
        payments: [
          { id: "5", ledger: 50 },
          { id: "4", ledger: 40 },
          { id: "3", ledger: 30 },
          { id: "2", ledger: 20 },
          { id: "1", ledger: 10 },
        ],
      });
      const inspector = new AccountInspector({ horizonServer: server, pageSize: 2 });
      const res = await inspector.paymentsFrom(OURS, { sinceLedger: 30 });
      if (!res.ok) throw new Error(res.error.message);
      expect(res.value).toMatchObject({ truncated: false });
      expect(res.value.payments.map((p) => p.ledger)).toEqual([50, 40, 30]);
      expect(calls.pagesRead).toBe(2);
    });

    it("reports truncated when the page budget runs out first", async () => {
      const payments = Array.from({ length: 7 }, (_, i) => ({
        id: String(7 - i),
        ledger: 70 - i,
      }));
      const { server, calls } = fakeHorizon({ payments });
      const inspector = new AccountInspector({
        horizonServer: server,
        pageSize: 2,
        maxPages: 2,
      });
      const res = await inspector.paymentsFrom(OURS);
      if (!res.ok) throw new Error(res.error.message);
      expect(res.value.truncated).toBe(true);
      expect(res.value.payments).toHaveLength(4);
      expect(calls.pagesRead).toBe(2);
    });

    it("reads every page when the history ends on a full page boundary", async () => {
      const payments = Array.from({ length: 4 }, (_, i) => ({
        id: String(4 - i),
        ledger: 40 - i,
      }));
      const { server } = fakeHorizon({ payments });
      const inspector = new AccountInspector({ horizonServer: server, pageSize: 2 });
      const res = await inspector.paymentsFrom(OURS);
      if (!res.ok) throw new Error(res.error.message);
      expect(res.value).toMatchObject({ truncated: false });
      expect(res.value.payments).toHaveLength(4);
    });

    it("fails when a payment comes back without its joined transaction", async () => {
      const { server } = fakeHorizon({ payments: [{ id: "1", ledger: 10, unjoined: true }] });
      const res = await new AccountInspector({ horizonServer: server }).paymentsFrom(OURS);
      expect(res.ok).toBe(false);
    });

    it("returns no payments for an account Horizon has never seen", async () => {
      const { server } = fakeHorizon({ paymentsError: new NotFoundError("not found", {}) });
      const res = await new AccountInspector({ horizonServer: server }).paymentsFrom(OURS);
      expect(res).toEqual({ ok: true, value: { payments: [], truncated: false } });
    });

    it("fails retryably when Horizon is down", async () => {
      const { server } = fakeHorizon({ paymentsError: new Error("ECONNRESET") });
      const res = await new AccountInspector({ horizonServer: server }).paymentsFrom(OURS);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.retryable).toBe(true);
    });
  });

  it("never parses amounts as floats", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../packages/stellar/src/index.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/parseFloat|\bNumber\(|parseInt/);
  });
});

describe("balanceCheck gate check (chain.balance)", () => {
  function testContext(
    opts: {
      bridgeAsset?: string;
      assetIssuer?: string;
      amount?: string;
    } = {},
  ): GateContext {
    const base = testCorridor();
    const bridge_asset = opts.bridgeAsset ?? "USDC";
    const amount = opts.amount ?? "100.0000000";
    return {
      intent: {
        idempotencyKey: "test-key-1",
        corridorId: "test",
        sender: { id: "sender-1" },
        recipient: { id: "recip-1" },
        sourceAmount: { asset: bridge_asset, amount },
      },
      corridor: {
        ...base,
        settlement: {
          ...base.settlement,
          bridge_asset,
          asset_issuer: opts.assetIssuer ?? base.settlement.asset_issuer,
        },
      },
      quote: {
        id: "q-test-1",
        sourceAmount: { asset: bridge_asset, amount },
        destAmount: { asset: "iso4217:ARS", amount: "10000" },
        price: "100",
        expiresAt: Date.now() + 60_000,
        firm: true,
      },
      opened: {
        transactionId: "tx-1",
        depositAddress: Keypair.random().publicKey(),
        memo: "memo123",
        memoType: "text",
      },
      now: Date.now(),
      attempt: 1,
    };
  }

  function mockInspector(facts: AccountFacts | undefined) {
    return {
      account: async () => ({ ok: true as const, value: facts }),
    };
  }

  it("has the name 'chain.balance'", () => {
    const check = balanceCheck(mockInspector(undefined), "G1");
    expect(check.name).toBe("chain.balance");
  });

  it("fails with PRESETTLE_INSUFFICIENT_FUNDS if account does not exist (404)", async () => {
    const check = balanceCheck(mockInspector(undefined), "G1");
    const res = await check.run(testContext());
    expect(res.passed).toBe(false);
    expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
    expect(res.detail).toContain("does not exist on-chain");
  });

  describe("exact-cover and one stroop short (non-XLM bridge asset)", () => {
    it("exact-cover passes", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          { asset_type: "native", balance: "1.0000100", selling_liabilities: "0" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            selling_liabilities: "0",
          },
        ],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ amount: "100.0000000" }));
      expect(res.passed).toBe(true);
      expect(res.detail).toContain("balance covers USDC amount 100.0000000");
    });

    it("fails when bridge asset is one stroop short (0.0000001 short)", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          { asset_type: "native", balance: "1.0000100", selling_liabilities: "0" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "99.9999999",
            selling_liabilities: "0",
          },
        ],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ amount: "100.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(res.detail).toContain("insufficient USDC");
      expect(res.detail).toContain("required 100.0000000");
      expect(res.detail).toContain("available 99.9999999");
    });

    it("fails when XLM balance is one stroop short of fee + reserve", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          { asset_type: "native", balance: "1.0000099", selling_liabilities: "0" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            selling_liabilities: "0",
          },
        ],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ amount: "100.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(res.detail).toContain("insufficient XLM for fee and reserve");
      expect(res.detail).toContain("required 0.00001");
      expect(res.detail).toContain("available 0.0000099");
    });
  });

  describe("liabilities reduce available", () => {
    it("bridge asset liabilities reduce available below amount", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          { asset_type: "native", balance: "5.0000000", selling_liabilities: "0" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "150.0000000",
            selling_liabilities: "60.0000000",
          },
        ],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ amount: "100.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(res.detail).toContain("available 90");
    });

    it("XLM liabilities reduce available below fee + reserve", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [
          {
            asset_type: "native",
            balance: "2.0000100",
            selling_liabilities: "1.0000001",
          },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            selling_liabilities: "0",
          },
        ],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ amount: "100.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(res.detail).toContain("insufficient XLM for fee and reserve");
    });
  });

  describe("XLM bridge asset counts amount+fee against the same balance", () => {
    it("exact-cover passes for XLM bridge asset", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [{ asset_type: "native", balance: "51.0000100", selling_liabilities: "0" }],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ bridgeAsset: "XLM", amount: "50.0000000" }));
      expect(res.passed).toBe(true);
      expect(res.detail).toContain("balance covers XLM amount 50.0000000 and fee 0.00001");
    });

    it("one stroop short fails for XLM bridge asset", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [{ asset_type: "native", balance: "51.0000099", selling_liabilities: "0" }],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ bridgeAsset: "XLM", amount: "50.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(res.detail).toContain("insufficient XLM");
      expect(res.detail).toContain("required 50.00001");
      expect(res.detail).toContain("available 50.0000099");
    });

    it("fails if balance covers amount + fee but ignores minimum reserve", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [{ asset_type: "native", balance: "50.0000100", selling_liabilities: "0" }],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ bridgeAsset: "XLM", amount: "50.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
    });

    it("fails if balance covers amount + reserve but ignores fee", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 0,
        num_sponsoring: 0,
        num_sponsored: 0,
        balances: [{ asset_type: "native", balance: "51.0000000", selling_liabilities: "0" }],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ bridgeAsset: "XLM", amount: "50.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
    });
  });

  describe("minimum reserve formula with sponsoring and sponsored counts", () => {
    it("exact cover with sponsoring and sponsored entries passes", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 3,
        num_sponsoring: 2,
        num_sponsored: 1,
        balances: [
          { asset_type: "native", balance: "3.0000100", selling_liabilities: "0" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            selling_liabilities: "0",
          },
        ],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ amount: "100.0000000" }));
      expect(res.passed).toBe(true);
    });

    it("one stroop short of calculated reserve formula fails", async () => {
      const facts: AccountFacts = {
        id: "G1",
        subentry_count: 3,
        num_sponsoring: 2,
        num_sponsored: 1,
        balances: [
          { asset_type: "native", balance: "3.0000099", selling_liabilities: "0" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: ISSUER,
            balance: "100.0000000",
            selling_liabilities: "0",
          },
        ],
      };
      const check = balanceCheck(mockInspector(facts), "G1");
      const res = await check.run(testContext({ amount: "100.0000000" }));
      expect(res.passed).toBe(false);
      expect(res.code).toBe("PRESETTLE_INSUFFICIENT_FUNDS");
      expect(res.detail).toContain("minimum reserve 3");
    });
  });
});

describe("StellarSettlementSubmitter.findExisting", () => {
  const kp = Keypair.random();
  const destKp = Keypair.random();

  function createSubmitterWithPayments(payments: Record<string, unknown>[]) {
    // Horizon's joined payments feed: memo and ledger ride on transaction_attr.
    const records = payments.map((r) => ({
      id: r.id,
      type: "payment",
      created_at: "2026-01-01T00:00:00Z",
      transaction_hash: r.transaction_hash,
      from: r.from,
      to: r.to,
      asset_type: r.asset_type,
      asset_code: r.asset_code,
      asset_issuer: r.asset_issuer,
      amount: r.amount,
      transaction_attr: {
        memo_type: r.memo_type ?? "none",
        memo: r.memo,
        ledger_attr: r.ledger ?? 1,
      },
    }));
    const fakePaymentsCall = {
      forAccount: () => fakePaymentsCall,
      join: () => fakePaymentsCall,
      order: () => fakePaymentsCall,
      limit: () => fakePaymentsCall,
      call: async () => ({ records, next: async () => ({ records: [] }) }),
    };
    const server = {
      loadAccount: async () => new Account(kp.publicKey(), "100"),
      submitTransaction: async () => ({}),
      transactions: () => ({
        transaction: () => ({ call: async () => ({ successful: true }) }),
      }),
      payments: () => fakePaymentsCall,
    };
    return new StellarSettlementSubmitter({
      signerSecret: kp.secret(),
      horizonUrl: "unused",
      horizonServer: server as unknown as Horizon.Server,
    });
  }

  it("finds an existing settlement with exact text memo and amount match", async () => {
    const sub = createSubmitterWithPayments([
      {
        id: "p1",
        transaction_hash: "existing-tx-1",
        from: kp.publicKey(),
        to: destKp.publicKey(),
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        amount: "10.0000000",
        memo: "memo-abc",
        memo_type: "text",
        ledger: 500,
      },
    ]);

    const req: SettlementRequest = {
      to: destKp.publicKey(),
      amount: { asset: "USDC", amount: "10" },
      memo: "memo-abc",
      memoType: "text",
      corridor: testCorridor(),
    };

    const res = await sub.findExisting(req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBeDefined();
      expect(res.value?.stellarTxHash).toBe("existing-tx-1");
      expect(res.value?.ledger).toBe(500);
    }
  });

  it("finds an existing settlement with hash memo (normalizing hex vs base64)", async () => {
    // 32-byte hash
    const hexHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const base64Hash = Buffer.from(hexHash, "hex").toString("base64");

    const sub = createSubmitterWithPayments([
      {
        id: "p1",
        transaction_hash: "hash-tx-1",
        from: kp.publicKey(),
        to: destKp.publicKey(),
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        amount: "10.0000000",
        memo: base64Hash,
        memo_type: "hash",
        ledger: 600,
      },
    ]);

    const req: SettlementRequest = {
      to: destKp.publicKey(),
      amount: { asset: "USDC", amount: "10.00" },
      memo: hexHash,
      memoType: "hash",
      corridor: testCorridor(),
    };

    const res = await sub.findExisting(req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value?.stellarTxHash).toBe("hash-tx-1");
      expect(res.value?.ledger).toBe(600);
    }
  });

  it("finds an existing XLM native settlement", async () => {
    const xlmCorridor = parseCorridor({
      id: "test-xlm",
      source: { name: "S", asset: "XLM", endpoints: { home_domain: "s.example" } },
      dest: {
        name: "D",
        asset: "iso4217:ARS",
        endpoints: {
          home_domain: "d.example",
          transfer_server_sep31: "https://d.example/sep31",
        },
      },
      fx: { path: ["ARS", "XLM", "ARS"], who_holds_risk: "receiving_anchor" },
      compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
      settlement: { network: "testnet", bridge_asset: "native", asset_issuer: ISSUER },
      recovery: { max_retries: 2 },
    });
    if (!xlmCorridor.ok) throw new Error(`bad corridor: ${JSON.stringify(xlmCorridor.error)}`);

    const sub = createSubmitterWithPayments([
      {
        id: "p1",
        transaction_hash: "xlm-tx-1",
        from: kp.publicKey(),
        to: destKp.publicKey(),
        asset_type: "native",
        amount: "5.0000000",
        memo: "12345",
        memo_type: "id",
        ledger: 700,
      },
    ]);

    const req: SettlementRequest = {
      to: destKp.publicKey(),
      amount: { asset: "XLM", amount: "5" },
      memo: "12345",
      memoType: "id",
      corridor: xlmCorridor.value,
    };

    const res = await sub.findExisting(req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value?.stellarTxHash).toBe("xlm-tx-1");
    }
  });

  it("returns ok(undefined) when destination, amount, or memo does not match", async () => {
    const sub = createSubmitterWithPayments([
      {
        id: "p1",
        transaction_hash: "tx-diff-memo",
        from: kp.publicKey(),
        to: destKp.publicKey(),
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: ISSUER,
        amount: "10.0000000",
        memo: "different-memo",
        memo_type: "text",
      },
    ]);

    const req: SettlementRequest = {
      to: destKp.publicKey(),
      amount: { asset: "USDC", amount: "10" },
      memo: "expected-memo",
      memoType: "text",
      corridor: testCorridor(),
    };

    const res = await sub.findExisting(req);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBeUndefined();
    }
  });
});

describe("destinationCheck gate check (chain.destination)", () => {
  const SIGNER = Keypair.random().publicKey();
  const DEST = Keypair.random().publicKey();

  function destContext(
    opts: { bridgeAsset?: string; destination?: string } = {},
  ): GateContext {
    const base = testCorridor();
    const bridge_asset = opts.bridgeAsset ?? "USDC";
    return {
      intent: {
        idempotencyKey: "test-key-1",
        corridorId: "test",
        sender: { id: "sender-1" },
        recipient: { id: "recip-1" },
        sourceAmount: { asset: bridge_asset, amount: "100" },
      },
      corridor: {
        ...base,
        settlement: { ...base.settlement, bridge_asset },
      },
      quote: {
        id: "q-test-1",
        sourceAmount: { asset: bridge_asset, amount: "100" },
        destAmount: { asset: "iso4217:ARS", amount: "10000" },
        price: "100",
        expiresAt: Date.now() + 60_000,
        firm: true,
      },
      opened: {
        transactionId: "tx-1",
        depositAddress: opts.destination ?? DEST,
        memo: "memo123",
        memoType: "text",
      },
      now: Date.now(),
      attempt: 1,
    };
  }

  function destFacts(balances: AccountFacts["balances"], id: string = DEST): AccountFacts {
    return { id, subentry_count: 0, num_sponsoring: 0, num_sponsored: 0, balances };
  }

  function mockInspector(facts: AccountFacts | undefined) {
    return { account: async () => ({ ok: true as const, value: facts }) };
  }

  const usdcTrustline = (is_authorized: boolean) => ({
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: ISSUER,
    balance: "0.0000000",
    is_authorized,
  });

  it("has the name 'chain.destination'", () => {
    expect(destinationCheck(mockInspector(undefined), SIGNER).name).toBe("chain.destination");
  });

  it("fails when the destination account does not exist", async () => {
    const result = await destinationCheck(mockInspector(undefined), SIGNER).run(destContext());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_DESTINATION_UNSAFE");
    expect(result.detail).toContain("exists");
  });

  it("fails when the destination has no trustline for the bridge asset", async () => {
    const facts = destFacts([{ asset_type: "native", balance: "10.0000000" }]);
    const result = await destinationCheck(mockInspector(facts), SIGNER).run(destContext());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_DESTINATION_UNSAFE");
    expect(result.detail).toContain("no USDC trustline");
  });

  it("fails when the trustline exists but is not authorized", async () => {
    const facts = destFacts([usdcTrustline(false)]);
    const result = await destinationCheck(mockInspector(facts), SIGNER).run(destContext());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_DESTINATION_UNSAFE");
    expect(result.detail).toContain("not authorized");
  });

  it("fails a self-payment before ever touching Horizon", async () => {
    const inspector = {
      account: async () => {
        throw new Error("must not be called for a self-payment");
      },
    };
    const result = await destinationCheck(inspector, SIGNER).run(
      destContext({ destination: SIGNER }),
    );
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_DESTINATION_UNSAFE");
    expect(result.detail).toContain("self-payment");
  });

  it("fails an operator-denylisted destination", async () => {
    const facts = destFacts([usdcTrustline(true)]);
    const result = await destinationCheck(mockInspector(facts), SIGNER, {
      denylist: (g) => g === DEST,
    }).run(destContext());
    expect(result.passed).toBe(false);
    expect(result.code).toBe("PRESETTLE_DESTINATION_UNSAFE");
    expect(result.detail).toContain("denylist");
  });

  it("passes native XLM with no trustline", async () => {
    const facts = destFacts([{ asset_type: "native", balance: "10.0000000" }]);
    const result = await destinationCheck(mockInspector(facts), SIGNER).run(
      destContext({ bridgeAsset: "XLM" }),
    );
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("no trustline");
  });

  it("passes an existing destination with an authorized trustline", async () => {
    const facts = destFacts([usdcTrustline(true)]);
    const result = await destinationCheck(mockInspector(facts), SIGNER).run(destContext());
    expect(result.passed).toBe(true);
  });
});

describe("settlement on-chain verification", () => {
  const DEST = Keypair.random().publicKey();
  const HASH_B64 = Buffer.alloc(32, 7).toString("base64");

  function req(over: Partial<SettlementRequest> = {}): SettlementRequest {
    return {
      to: DEST,
      amount: { asset: "USDC", amount: "10" },
      corridor: testCorridor(),
      memo: "abc",
      memoType: "text",
      ...over,
    };
  }
  function facts(over: Partial<SettlementFacts> = {}, op: Record<string, unknown> = {}) {
    return {
      hash: "h",
      successful: true,
      memo: "abc",
      memoType: "text",
      operations: [
        {
          type: "payment",
          to: DEST,
          amount: "10.0000000",
          asset_type: "credit_alphanum4",
          asset_code: "USDC",
          asset_issuer: ISSUER,
          ...op,
        },
      ],
      ...over,
    } as SettlementFacts;
  }

  it("accepts a matching payment (Horizon 7-decimal amount equals request)", () => {
    expect(verifySettlementFacts(facts(), req()).ok).toBe(true);
  });

  it("accepts matching hash and id memos and native XLM", () => {
    expect(
      verifySettlementFacts(
        facts({ memo: HASH_B64, memoType: "hash" }),
        req({ memo: HASH_B64, memoType: "hash" }),
      ).ok,
    ).toBe(true);
    expect(
      verifySettlementFacts(
        facts({ memo: "42", memoType: "id" }),
        req({ memo: "42", memoType: "id" }),
      ).ok,
    ).toBe(true);
    const xlm = testCorridor();
    const native = { ...xlm, settlement: { ...xlm.settlement, bridge_asset: "XLM" } };
    expect(
      verifySettlementFacts(
        facts({}, { asset_type: "native", asset_code: undefined, asset_issuer: undefined }),
        req({ corridor: native }),
      ).ok,
    ).toBe(true);
  });

  const cases: [string, SettlementFacts, SettlementRequest, string][] = [
    ["destination", facts({}, { to: Keypair.random().publicKey() }), req(), "destination"],
    ["amount", facts({}, { amount: "9.9999999" }), req(), "amount"],
    ["memo", facts({ memo: "zzz" }), req(), "memo"],
    [
      "memo type",
      facts({ memo: "42", memoType: "id" }),
      req({ memo: "42", memoType: "text" }),
      "memo type",
    ],
    ["asset code", facts({}, { asset_code: "EURC" }), req(), "asset"],
    [
      "asset issuer",
      facts({}, { asset_issuer: Keypair.random().publicKey() }),
      req(),
      "asset",
    ],
    ["native instead of USDC", facts({}, { asset_type: "native" }), req(), "asset"],
    ["failed tx", facts({ successful: false }), req(), "failed on-chain"],
    [
      "extra operation",
      facts({ operations: [facts().operations[0]!, facts().operations[0]!] }),
      req(),
      "operation count",
    ],
    ["not a payment", facts({}, { type: "create_account" }), req(), "operation type"],
    ["unexpected memo", facts(), req({ memo: undefined }), "memo type"],
  ];
  it.each(cases)("rejects a wrong %s with RECONCILE_MISMATCH", (_n, f, r, needle) => {
    const out = verifySettlementFacts(f, r);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("RECONCILE_MISMATCH");
      expect(out.error.retryable).toBe(false);
      expect(out.error.message).toContain(needle);
    }
  });

  it("AccountInspector.settlementFacts reads tx + ops and feeds the verifier", async () => {
    const server = {
      loadAccount: async () => ({}),
      transactions: () => ({
        transaction: () => ({
          call: async () => ({ successful: true, memo: "abc", memo_type: "text" }),
        }),
      }),
      operations: () => ({
        forTransaction: () => ({
          limit: () => ({ call: async () => ({ records: facts().operations }) }),
        }),
      }),
    } as unknown as Horizon.Server;
    const verify = createChainVerifier(new AccountInspector({ horizonServer: server }));
    expect((await verify({ stellarTxHash: "h" }, req())).ok).toBe(true);
    const bad = await verify(
      { stellarTxHash: "h" },
      req({ to: Keypair.random().publicKey() }),
    );
    expect(bad.ok).toBe(false);
  });
});
