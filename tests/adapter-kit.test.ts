import { describe, expect, it } from "vitest";
import { conformanceSuite, createMockAdapter } from "@corridor/adapter-kit";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

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
});
