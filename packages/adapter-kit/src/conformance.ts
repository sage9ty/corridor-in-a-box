import type { Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";
import type { AnchorAdapter, AdapterCapabilities } from "./index";

export interface ConformanceProbeResult {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly adapterName: string;
  readonly passed: boolean;
  readonly results: readonly ConformanceProbeResult[];
}

export interface ConformanceContext {
  readonly intent: PaymentIntent;
  readonly corridor: Corridor;
}

export interface ConformanceOptions {
  /**
   * Whether to exercise methods that may write to the network/anchor (e.g. openTransaction).
   * Defaults to false for safe read-only conformance checks.
   */
  readonly allowNetworkWrites?: boolean;
}

const VALID_QUOTE_KINDS = ["sep38_firm", "sep38_indicative", "native", "none"] as const;
const VALID_KYC_KINDS = ["sep12", "sep6_fields", "bespoke", "none"] as const;
const VALID_REFUND_KINDS = ["request", "report_only", "none"] as const;
const VALID_KYC_STATUSES = ["accepted", "pending", "rejected"] as const;

export async function runConformance(
  adapter: AnchorAdapter,
  ctx: ConformanceContext,
  opts: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const results: ConformanceProbeResult[] = [];

  // Probe 1: capabilities well-formed
  let caps: AdapterCapabilities | undefined;
  try {
    caps = adapter.capabilities();
    const validProtocol = typeof caps?.protocol === "string" && caps.protocol.length > 0;
    const validQuotes =
      Array.isArray(caps?.quotes) &&
      caps.quotes.length > 0 &&
      caps.quotes.every((q) => (VALID_QUOTE_KINDS as readonly string[]).includes(q));
    const validKyc = (VALID_KYC_KINDS as readonly string[]).includes(caps?.kyc ?? "");
    const validSettlement = Array.isArray(caps?.settlement) && caps.settlement.length > 0;
    const validRefunds = (VALID_REFUND_KINDS as readonly string[]).includes(
      caps?.refunds ?? "",
    );
    const validCallbacks = typeof caps?.callbacks === "boolean";

    if (
      validProtocol &&
      validQuotes &&
      validKyc &&
      validSettlement &&
      validRefunds &&
      validCallbacks
    ) {
      results.push({
        name: "capabilities well-formed",
        passed: true,
        detail: `protocol=${caps.protocol}, quotes=[${caps.quotes.join(",")}], kyc=${caps.kyc}, settlement=[${caps.settlement.join(",")}], refunds=${caps.refunds}`,
      });
    } else {
      results.push({
        name: "capabilities well-formed",
        passed: false,
        detail: `invalid capabilities structure: ${JSON.stringify(caps)}`,
      });
    }
  } catch (e) {
    results.push({
      name: "capabilities well-formed",
      passed: false,
      detail: `capabilities() threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Probe 2: quote kinds match capabilities
  try {
    const q = await adapter.requestQuote(ctx.intent, ctx.corridor);
    if (!q || typeof q.ok !== "boolean") {
      results.push({
        name: "quote returns an Outcome",
        passed: false,
        detail: "requestQuote returned a non-Outcome value",
      });
    } else if (caps?.quotes.includes("none") && !q.ok) {
      results.push({
        name: "quote returns an Outcome",
        passed: true,
        detail: `adapter configured without quotes returned expected failure: ${q.error.code}`,
      });
    } else if (q.ok) {
      const futureExpiry =
        typeof q.value.expiresAt === "number" && q.value.expiresAt > Date.now();
      results.push({
        name: "quote returns an Outcome",
        passed: futureExpiry,
        detail: futureExpiry
          ? `received quote ${q.value.id} expiring at ${new Date(q.value.expiresAt).toISOString()}`
          : `quote expiry (${q.value.expiresAt}) is not in the future`,
      });
    } else {
      results.push({
        name: "quote returns an Outcome",
        passed: true,
        detail: `quote request returned Outcome error: ${q.error.code}`,
      });
    }
  } catch (e) {
    results.push({
      name: "quote returns an Outcome",
      passed: false,
      detail: `requestQuote threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Probe 3: compliance status known
  try {
    const comp = await adapter.ensureCompliance(ctx.intent, ctx.corridor);
    if (!comp || typeof comp.ok !== "boolean") {
      results.push({
        name: "compliance resolves to a known status",
        passed: false,
        detail: "ensureCompliance returned a non-Outcome value",
      });
    } else if (comp.ok) {
      const known = (VALID_KYC_STATUSES as readonly string[]).includes(comp.value.status);
      results.push({
        name: "compliance resolves to a known status",
        passed: known,
        detail: known
          ? `compliance status resolved to "${comp.value.status}"`
          : `unknown compliance status "${comp.value.status}"`,
      });
    } else {
      results.push({
        name: "compliance resolves to a known status",
        passed: true,
        detail: `compliance returned failure Outcome: ${comp.error.code}`,
      });
    }
  } catch (e) {
    results.push({
      name: "compliance resolves to a known status",
      passed: false,
      detail: `ensureCompliance threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Probe 4: openTransaction (only when allowNetworkWrites is true)
  if (opts.allowNetworkWrites) {
    try {
      const quoteRes = await adapter.requestQuote(ctx.intent, ctx.corridor);
      const dummyQuote = quoteRes.ok
        ? quoteRes.value
        : {
            id: "conformance-quote",
            price: "1.00",
            expiresAt: Date.now() + 60_000,
            sourceAmount: ctx.intent.sourceAmount,
            destAmount: {
              asset: ctx.corridor.dest.asset,
              amount: ctx.intent.sourceAmount.amount,
            },
            firm: true,
          };

      const opened = await adapter.openTransaction(ctx.intent, dummyQuote, ctx.corridor);
      if (!opened || typeof opened.ok !== "boolean") {
        results.push({
          name: "openTransaction returns valid Outcome",
          passed: false,
          detail: "openTransaction returned a non-Outcome value",
        });
      } else if (opened.ok) {
        const kind = opened.value.instructions?.kind;
        const advertised = caps ? (caps.settlement as readonly string[]) : undefined;
        const hasInstructions =
          typeof opened.value.transactionId === "string" &&
          kind !== undefined &&
          (advertised === undefined || advertised.includes(kind));
        results.push({
          name: "openTransaction returns valid Outcome",
          passed: hasInstructions,
          detail: hasInstructions
            ? `opened tx ${opened.value.transactionId} with ${kind} instructions`
            : `openTransaction succeeded but returned no transactionId, no instructions, or instruction kind "${String(kind)}" not listed in capabilities().settlement`,
        });
      } else {
        results.push({
          name: "openTransaction returns valid Outcome",
          passed: true,
          detail: `openTransaction returned error Outcome: ${opened.error.code}`,
        });
      }
    } catch (e) {
      results.push({
        name: "openTransaction returns valid Outcome",
        passed: false,
        detail: `openTransaction threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  // Probe 5: getTransaction on an unknown id returns an Outcome failure, not a throw
  try {
    const tx = await adapter.getTransaction("unknown_conformance_id_999999");
    if (!tx || typeof tx.ok !== "boolean") {
      results.push({
        name: "getTransaction handles unknown id without throw",
        passed: false,
        detail: "getTransaction returned a non-Outcome value",
      });
    } else {
      results.push({
        name: "getTransaction handles unknown id without throw",
        passed: true,
        detail: tx.ok
          ? `returned status ${tx.value.status}`
          : `returned expected error Outcome: ${tx.error.code}`,
      });
    }
  } catch (e) {
    results.push({
      name: "getTransaction handles unknown id without throw",
      passed: false,
      detail: `getTransaction threw unhandled exception: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // Probe 6: no method throws for a malformed corridor
  try {
    const malformedCorridor = {
      ...ctx.corridor,
      dest: {
        ...ctx.corridor.dest,
        endpoints: { home_domain: "invalid.domain.empty" },
      },
    } as unknown as Corridor;

    const r1 = await adapter.requestQuote(ctx.intent, malformedCorridor);
    const r2 = await adapter.ensureCompliance(ctx.intent, malformedCorridor);
    const safeOutcomes = r1 && typeof r1.ok === "boolean" && r2 && typeof r2.ok === "boolean";
    results.push({
      name: "handles malformed corridor without throw",
      passed: safeOutcomes,
      detail: safeOutcomes
        ? "calls with malformed corridor safely returned Outcomes"
        : "calls with malformed corridor returned invalid response",
    });
  } catch (e) {
    results.push({
      name: "handles malformed corridor without throw",
      passed: false,
      detail: `call with malformed corridor threw: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const passed = results.every((r) => r.passed);
  return {
    adapterName: adapter.name,
    passed,
    results,
  };
}
