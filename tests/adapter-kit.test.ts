import { describe, expect, it } from "vitest";
import {
  conformanceSuite,
  createMockAdapter,
  runConformance,
  toLegacy,
  type AnchorAdapter,
} from "@corridor/adapter-kit";
import { Sep31Adapter } from "@corridor/sep31";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";
import { expectConformance } from "./helpers/conformance";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: { name: "D", asset: "iso4217:ARS", endpoints: { home_domain: "d.example" } },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

const intent: PaymentIntent = {
  idempotencyKey: "k",
  corridorId: "test",
  sender: { id: "s" },
  recipient: { id: "r" },
  sourceAmount: { asset: "USDC", amount: "100" },
};

describe("conformanceSuite", () => {
  it("returns exactly the two documented probes, by name", () => {
    const probes = conformanceSuite(createMockAdapter(), intent, corridor());
    expect(probes.map((p) => p.name)).toEqual([
      "quote returns a future expiry",
      "compliance resolves to a known status",
    ]);
  });

  it("both probes pass against a healthy mock adapter", async () => {
    const probes = conformanceSuite(createMockAdapter(), intent, corridor());
    for (const p of probes) expect(await p.run()).toBe(true);
  });

  it("the quote probe fails when the quote is already expired", async () => {
    const probes = conformanceSuite(
      createMockAdapter({ expireQuoteImmediately: true }),
      intent,
      corridor(),
    );
    const quoteProbe = probes.find((p) => p.name === "quote returns a future expiry")!;
    expect(await quoteProbe.run()).toBe(false);
  });

  it("the compliance probe passes even when KYC is rejected — it only checks shape, not success", async () => {
    const probes = conformanceSuite(
      createMockAdapter({ kyc: "rejected" }),
      intent,
      corridor(),
    );
    const complianceProbe = probes.find(
      (p) => p.name === "compliance resolves to a known status",
    )!;
    expect(await complianceProbe.run()).toBe(true);
  });
});

describe("createMockAdapter", () => {
  it("defaults name to mock-anchor", () => {
    expect(createMockAdapter().name).toBe("mock-anchor");
  });

  it("honors an overridden name", () => {
    expect(createMockAdapter({ name: "acme" }).name).toBe("acme");
  });

  it("requestQuote and openTransaction share a single incrementing counter", async () => {
    const adapter = createMockAdapter();
    const q = await adapter.requestQuote(intent, corridor());
    if (!q.ok) throw new Error("expected quote to succeed");
    expect(q.value.id).toBe("q_1");
    const tx = await adapter.openTransaction(intent, q.value, corridor());
    expect(tx.ok && tx.value.transactionId).toBe("tx_2");
  });

  it("ensureCompliance always returns customerId cust_mock, regardless of KYC status", async () => {
    for (const status of ["accepted", "pending", "rejected"] as const) {
      const r = await createMockAdapter({ kyc: status }).ensureCompliance(intent, corridor());
      expect(r.ok && r.value.customerId).toBe("cust_mock");
      expect(r.ok && r.value.status).toBe(status);
    }
  });

  it("getTransaction: terminalFailure takes priority over settled", async () => {
    const r = await createMockAdapter({ terminalFailure: true, settled: true }).getTransaction(
      "tx_1",
    );
    expect(r.ok && r.value).toEqual({
      status: "error",
      settled: false,
      terminalFailure: true,
    });
  });

  it("getTransaction: defaults to completed/settled", async () => {
    const r = await createMockAdapter().getTransaction("tx_1");
    expect(r.ok && r.value).toEqual({ status: "completed", settled: true });
  });

  it("getTransaction: settled:false reports pending_receiver", async () => {
    const r = await createMockAdapter({ settled: false }).getTransaction("tx_1");
    expect(r.ok && r.value).toEqual({ status: "pending_receiver", settled: false });
  });

  it("getTransaction: reports back what an opened transaction expects", async () => {
    const adapter = createMockAdapter();
    const q = await adapter.requestQuote(intent, corridor());
    if (!q.ok) throw new Error("expected quote to succeed");
    const tx = await adapter.openTransaction(intent, q.value, corridor());
    if (!tx.ok) throw new Error("expected open to succeed");

    const r = await adapter.getTransaction(tx.value.transactionId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amountIn).toEqual(q.value.sourceAmount);
    expect(r.value.depositAddress).toBe(tx.value.depositAddress);
    expect(r.value.memo).toBe(tx.value.memo);
    expect(r.value.memoType).toBe(tx.value.memoType);
    // Classification is unchanged by the extra fields.
    expect(r.value.status).toBe("completed");
    expect(r.value.settled).toBe(true);
  });

  it("getTransaction: carries the opened fields on a terminal failure too", async () => {
    const adapter = createMockAdapter({ terminalFailure: true });
    const q = await adapter.requestQuote(intent, corridor());
    if (!q.ok) throw new Error("expected quote to succeed");
    const tx = await adapter.openTransaction(intent, q.value, corridor());
    if (!tx.ok) throw new Error("expected open to succeed");

    const r = await adapter.getTransaction(tx.value.transactionId);
    expect(r.ok && r.value.terminalFailure).toBe(true);
    expect(r.ok && r.value.depositAddress).toBe(tx.value.depositAddress);
  });

  it("getTransaction: leaves the fields absent for a transaction never opened", async () => {
    const r = await createMockAdapter().getTransaction("tx_unknown");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.amountIn).toBeUndefined();
    expect(r.value.depositAddress).toBeUndefined();
    expect(r.value.memo).toBeUndefined();
  });

  it("getTransaction: includes refund details when configured", async () => {
    const refundStatus = {
      amountRefunded: { asset: "USDC", amount: "100.00" },
      amountFee: { asset: "USDC", amount: "2.00" },
      payments: [
        {
          id: "ref-pay-1",
          idType: "stellar",
          amount: { asset: "USDC", amount: "98.00" },
          fee: { asset: "USDC", amount: "2.00" },
        },
      ],
      completeness: "full" as const,
    };
    const r = await createMockAdapter({ refundStatus }).getTransaction("tx_1");
    expect(r.ok && r.value.refunds).toEqual(refundStatus);
  });

  it('requestRefund: refund:"complete" reports the refund already done', async () => {
    const r = await createMockAdapter({ refund: "complete" }).requestRefund(
      "tx_1",
      { asset: "USDC", amount: "100.00" },
      "payout timed out",
    );
    expect(r.ok && r.value.status).toBe("refunded");
  });

  it('requestRefund: refund:"pending" reports it accepted but not yet moved', async () => {
    const r = await createMockAdapter({ refund: "pending" }).requestRefund(
      "tx_1",
      { asset: "USDC", amount: "100.00" },
      "payout timed out",
    );
    expect(r.ok && r.value.status).toBe("pending");
  });

  it('requestRefund: refund:"rejected" reports the anchor declining', async () => {
    const r = await createMockAdapter({ refund: "rejected" }).requestRefund(
      "tx_1",
      { asset: "USDC", amount: "100.00" },
      "payout timed out",
    );
    expect(r.ok && r.value.status).toBe("rejected");
  });

  it("requestRefund: defaults to pending refund response", async () => {
    const adapter = createMockAdapter();
    const r = await adapter.requestRefund(
      "tx_1",
      { asset: "USDC", amount: "100.00" },
      "payout timed out",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.transactionId).toBe("tx_1");
      expect(r.value.status).toBe("pending");
      expect(r.value.message).toContain("100.00 USDC");
    }
  });

  it("requestRefund: honors overridden refundResult", async () => {
    const adapter = createMockAdapter({
      refundResult: {
        ok: true,
        value: {
          transactionId: "tx_custom",
          status: "refunded",
          refundId: "ref_123",
        },
      },
    });
    const r = await adapter.requestRefund(
      "tx_custom",
      { asset: "USDC", amount: "50" },
      "reason",
    );
    expect(r.ok && r.value).toEqual({
      transactionId: "tx_custom",
      status: "refunded",
      refundId: "ref_123",
    });
  });

  it("capabilities: mock adapter returns default and honors override (#187)", () => {
    const def = createMockAdapter();
    expect(def.capabilities()).toEqual({
      protocol: "mock",
      quotes: ["sep38_firm"],
      kyc: "sep12",
      settlement: ["stellar_payment"],
      refunds: "request",
      callbacks: false,
    });

    const overridden = createMockAdapter({
      capabilities: {
        protocol: "custom-mock",
        quotes: ["native"],
        callbacks: true,
      },
    });
    expect(overridden.capabilities()).toEqual({
      protocol: "custom-mock",
      quotes: ["native"],
      kyc: "sep12",
      settlement: ["stellar_payment"],
      refunds: "request",
      callbacks: true,
    });
  });

  it("openTransaction: returns instructions with kind 'stellar_payment'", async () => {
    const adapter = createMockAdapter();
    const q = await adapter.requestQuote(intent, corridor());
    if (!q.ok) throw new Error("quote failed");
    const r = await adapter.openTransaction(intent, q.value, corridor());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.instructions.kind).toBe("stellar_payment");
    if (r.value.instructions.kind === "stellar_payment") {
      expect(r.value.instructions.to).toBe(r.value.depositAddress);
      expect(r.value.instructions.memo).toBe(r.value.memo);
    }
  });

  it("toLegacy: extracts legacy fields from stellar_payment instructions", () => {
    const legacy = toLegacy({
      transactionId: "tx_1",
      instructions: {
        kind: "stellar_payment",
        to: "GDESTINATION",
        memo: "12345",
        memoType: "id",
      },
    });
    expect(legacy).toEqual({
      depositAddress: "GDESTINATION",
      memo: "12345",
      memoType: "id",
    });
  });

  it("toLegacy: returns empty object for non-stellar instruction kinds when no legacy fallback", () => {
    const legacy = toLegacy({
      transactionId: "tx_2",
      instructions: {
        kind: "claimable_balance",
        claimant: "GCLAIMANT",
      },
    });
    expect(legacy.depositAddress).toBeUndefined();
    expect(legacy.memo).toBeUndefined();
  });
});

describe("runConformance harness (#199)", () => {
  it("passes for createMockAdapter()", async () => {
    const adapter = createMockAdapter();
    const report = await runConformance(
      adapter,
      { intent, corridor: corridor() },
      {
        allowNetworkWrites: true,
      },
    );
    expectConformance(report);
  });

  it("passes for Sep31Adapter with mock fetch", async () => {
    const mockFetch = (async (input: string | URL) => {
      const url = input.toString();
      if (url.includes("/sep31/info")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            receive: { ARS: { min_amount: "1", max_amount: "1000" } },
          }),
        };
      }
      if (url.includes("/sep12/customer")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ACCEPTED" }),
        };
      }
      if (url.includes("/sep38/quote")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "q_1",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            price: "1.00",
            total_price: "1.00",
            sell_amount: "100",
            buy_amount: "100",
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }) as unknown as typeof fetch;

    const sepCorridor = parseCorridor({
      id: "sep31-test",
      source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
      dest: {
        name: "D",
        asset: "iso4217:ARS",
        protocol: "sep31",
        endpoints: {
          home_domain: "d.example",
          transfer_server_sep31: "https://d.example/sep31",
          kyc_server: "https://d.example/sep12",
          quote_server: "https://d.example/sep38",
        },
      },
      fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
      compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
      settlement: { network: "public", asset_issuer: "GISSUER" },
      recovery: {},
    });
    if (!sepCorridor.ok) throw new Error("sepCorridor invalid");

    const sep31 = new Sep31Adapter(sepCorridor.value, { fetchImpl: mockFetch });

    const report = await runConformance(sep31, { intent, corridor: sepCorridor.value });
    expectConformance(report);
  });

  it("a deliberately broken mock (throws in getTransaction) fails the right probe", async () => {
    const broken = createMockAdapter();
    const adapterWithThrow: AnchorAdapter = {
      ...broken,
      async getTransaction() {
        throw new Error("unexpected unhandled database failure");
      },
    };

    const report = await runConformance(adapterWithThrow, { intent, corridor: corridor() });
    expect(report.passed).toBe(false);
    const probe = report.results.find(
      (r) => r.name === "getTransaction handles unknown id without throw",
    );
    expect(probe).toBeDefined();
    expect(probe?.passed).toBe(false);
    expect(probe?.detail).toContain("unexpected unhandled database failure");
  });

  it("a mock with invalid capabilities structure fails the capabilities probe", async () => {
    const invalidCapsAdapter: AnchorAdapter = {
      ...createMockAdapter(),
      capabilities() {
        return {
          protocol: "",
          quotes: [] as unknown as "sep38_firm"[],
          kyc: "invalid_kyc" as unknown as "sep12",
          settlement: [],
          refunds: "none",
          callbacks: false,
        };
      },
    };

    const report = await runConformance(invalidCapsAdapter, { intent, corridor: corridor() });
    expect(report.passed).toBe(false);
    const probe = report.results.find((r) => r.name === "capabilities well-formed");
    expect(probe?.passed).toBe(false);
  });
});
