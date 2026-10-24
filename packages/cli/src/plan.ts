// corridor plan — what would this corridor actually do, and in what order?
//
// `plan` used to hard-code the SEP-31 step list, so a SEP-6 or bespoke corridor
// was told to call endpoints it does not expose. The step list is derived from
// the manifest instead: the destination protocol, quote source, compliance
// method and settlement kind. `--json` exposes the same structure for tooling.

import {
  liveness,
  protocolOf,
  type ComplianceMethod,
  type Corridor,
  type DestProtocol,
  type Liveness,
} from "@corridor/manifest";

/** The five engine verbs, in execution order. */
export type PlanVerb = "quote" | "comply" | "open" | "settle" | "reconcile";

export interface PlanStep {
  /** 1-based position in the canonical engine verb order. */
  readonly step: number;
  readonly verb: PlanVerb;
  /** Protocol or mechanism this step uses (e.g. "sep38", "sep12", "sep6"). */
  readonly protocol: string;
  /** What the step does, in the corridor's actual protocol. */
  readonly detail: string;
}

/** How customer compliance is handled for the destination leg. */
export type { ComplianceMethod };

export interface PlanSettlement {
  /** How the bridge asset reaches the destination anchor. */
  readonly kind: "stellar_payment" | "adapter_settled";
  readonly asset: string;
  readonly network: string;
}

export interface Plan {
  readonly corridor: string;
  /** Destination protocol: "sep31", "sep6" or "custom:<id>". */
  readonly protocol: string;
  readonly source: {
    readonly name: string;
    readonly protocol: string;
    readonly asset: string;
  };
  readonly settlement: PlanSettlement;
  readonly compliance: {
    readonly method: ComplianceMethod;
    readonly source_jurisdiction: string;
    readonly dest_jurisdiction: string;
  };
  readonly fx: {
    readonly path: readonly string[];
    readonly quote_source: string;
  };
  readonly steps: readonly PlanStep[];
  readonly liveness: Liveness;
}

type StepDraft = Omit<PlanStep, "step">;

function quoteStep(c: Corridor, protocol: DestProtocol): StepDraft {
  const endpoints = c.dest.endpoints;
  if (c.fx.quote_source === "sep38") {
    const quoteServer = "quote_server" in endpoints ? endpoints.quote_server : undefined;
    const context = protocol === "sep6" ? " (context=sep6)" : "";
    const missing = quoteServer ? "" : " — no quote_server configured";
    return {
      verb: "quote",
      protocol: "sep38",
      detail: `SEP-38 POST /quote${context}${missing}`,
    };
  }
  if (c.fx.quote_source === "native") {
    return {
      verb: "quote",
      protocol: "native",
      detail: "corridor-native rate (no external quote provider)",
    };
  }
  return {
    verb: "quote",
    protocol: "external",
    detail: "operator-supplied rate (not verified by this tool)",
  };
}

function complianceMethod(c: Corridor): ComplianceMethod {
  // An explicit manifest declaration wins; otherwise describe what the
  // protocol's adapter will do.
  if (c.compliance.method) return c.compliance.method;
  const endpoints = c.dest.endpoints;
  if ("kyc_server" in endpoints && endpoints.kyc_server) return "sep12";
  if (c.dest.protocol === "sep6") return "sep6_fields";
  if (c.dest.protocol.startsWith("custom:")) return "bespoke";
  return "none";
}

function complyStep(c: Corridor, method: ComplianceMethod): StepDraft {
  const endpoints = c.dest.endpoints;
  const auth = "web_auth" in endpoints && endpoints.web_auth ? "SEP-10 auth + " : "";
  if (method === "sep12") {
    return { verb: "comply", protocol: "sep12", detail: `${auth}SEP-12 KYC handoff` };
  }
  if (method === "sep6_fields") {
    return {
      verb: "comply",
      protocol: "sep6",
      detail: `${auth}SEP-6 /withdraw customer fields (no KYC server)`,
    };
  }
  if (method === "bespoke") {
    return { verb: "comply", protocol: "bespoke", detail: "adapter-defined KYC/compliance" };
  }
  return {
    verb: "comply",
    protocol: "none",
    detail: "no KYC server — assuming 1:1 delivery with no per-customer KYC",
  };
}

function openStep(protocol: DestProtocol): StepDraft {
  if (protocol === "sep31") {
    return { verb: "open", protocol: "sep31", detail: "SEP-31 POST /transactions" };
  }
  if (protocol === "sep6") {
    return { verb: "open", protocol: "sep6", detail: "SEP-6 POST /withdraw-exchange" };
  }
  return {
    verb: "open",
    protocol,
    detail: "adapter creates the payout/deposit request and returns typed instructions",
  };
}

function settleStep(c: Corridor, protocol: DestProtocol): StepDraft {
  const asset = c.settlement.bridge_asset;
  if (protocol === "sep31") {
    return {
      verb: "settle",
      protocol: "stellar_payment",
      detail: `native Stellar payment of ${asset} to the SEP-31 deposit account with the exact memo`,
    };
  }
  if (protocol === "sep6") {
    return {
      verb: "settle",
      protocol: "stellar_payment",
      detail: `native Stellar payment of ${asset} to the anchor's withdraw account (SEP-6, no deposit memo)`,
    };
  }
  return {
    verb: "settle",
    protocol: "adapter_settled",
    detail: `adapter-reported settlement of ${asset} (on-chain or off-chain)`,
  };
}

function reconcileStep(protocol: DestProtocol): StepDraft {
  if (protocol === "sep31") {
    return { verb: "reconcile", protocol: "sep31", detail: "SEP-31 GET /transactions/:id" };
  }
  if (protocol === "sep6") {
    return { verb: "reconcile", protocol: "sep6", detail: "SEP-6 GET /transaction" };
  }
  return { verb: "reconcile", protocol, detail: "adapter transaction status poll" };
}

function settlementKind(protocol: DestProtocol): PlanSettlement["kind"] {
  return protocol.startsWith("custom:") ? "adapter_settled" : "stellar_payment";
}

/** Build the protocol-aware plan for a validated corridor. */
export function buildPlan(c: Corridor): Plan {
  const protocol = protocolOf(c.dest);
  const method = complianceMethod(c);
  const drafts: StepDraft[] = [
    quoteStep(c, protocol),
    complyStep(c, method),
    openStep(protocol),
    settleStep(c, protocol),
    reconcileStep(protocol),
  ];
  return {
    corridor: c.id,
    protocol,
    source: { name: c.source.name, protocol: c.source.protocol, asset: c.source.asset },
    settlement: {
      kind: settlementKind(protocol),
      asset: c.settlement.bridge_asset,
      network: c.settlement.network,
    },
    compliance: {
      method,
      source_jurisdiction: c.compliance.source_jurisdiction,
      dest_jurisdiction: c.compliance.dest_jurisdiction,
    },
    fx: { path: [...c.fx.path], quote_source: c.fx.quote_source },
    steps: drafts.map((draft, index) => ({ ...draft, step: index + 1 })),
    liveness: liveness(c),
  };
}

/** Render the human-readable plan, including the same liveness block as before. */
export function formatPlan(c: Corridor, plan: Plan): string {
  const lines: string[] = [];
  const line = (s = "") => lines.push(s);
  line(`corridor: ${c.id}`);
  if (c.status_note) line(`note:     ${c.status_note}`);
  line(`protocol: ${plan.protocol}`);
  line(
    `route:    ${c.fx.path.join(" -> ")}   (risk: ${c.fx.who_holds_risk}, ttl ${c.fx.quote_ttl_seconds}s)`,
  );
  line(
    `source:   ${c.source.name}  [${c.source.asset}]  ${c.source.protocol}${c.source.endpoints?.home_domain ? `  ${c.source.endpoints.home_domain}` : ""}`,
  );
  line(`dest:     ${c.dest.name}  [${c.dest.asset}]  ${c.dest.endpoints.home_domain}`);
  line(`bridge:   ${c.settlement.bridge_asset} on ${c.settlement.network}`);
  if (c.limits && (c.limits.min_amount !== undefined || c.limits.max_amount !== undefined)) {
    const parts: string[] = [];
    if (c.limits.min_amount !== undefined) parts.push(`min=${c.limits.min_amount}`);
    if (c.limits.max_amount !== undefined) parts.push(`max=${c.limits.max_amount}`);
    line(`limits:   ${parts.join(" ")}`);
  }
  line(
    `recovery: retries=${c.recovery.max_retries}, timeout=${c.recovery.timeout_seconds}s, rollback=${c.recovery.rollback}, breaker=${c.recovery.breaker.consecutive_failures}`,
  );
  line();
  line("steps:");
  for (const step of plan.steps) {
    line(`  ${step.step}. ${step.verb.padEnd(9)} ${step.protocol.padEnd(8)} ${step.detail}`);
  }
  line();

  // Liveness comes from @corridor/manifest so this command and the web dashboard
  // can never describe the same corridor differently.
  const live = plan.liveness;

  if (live.state === "proven" && live.proof) {
    const hashPrefix = live.proof.stellar_tx_hash.slice(0, 8);
    const date = live.proof.canary_completed_at.slice(0, 10);
    const now = new Date();
    const completedAt = new Date(live.proof.canary_completed_at).getTime();
    const ageMs = now.getTime() - completedAt;
    const daysAgo = Math.max(0, Math.floor(ageMs / (24 * 60 * 60 * 1000)));
    const maxAge = live.proof.max_age_days ?? 30;
    const expiresIn = Math.max(0, maxAge - daysAgo);
    line(
      `liveness: ✓✓ PROVEN — canary ${hashPrefix} completed ${date} (${daysAgo} days ago, expires in ${expiresIn}d)`,
    );
  } else if (live.state === "verified") {
    line(`liveness: ✓ VERIFIED — endpoints confirmed ${live.verifiedAt} for all five steps`);
    const cap = c.proof?.canary_max_amount ?? c.limits?.max_amount ?? "default";
    if (c.proof) {
      // A proof is on file but liveness() did not honour it (stale, future-dated):
      // saying "none" would be wrong, and the reason is in the warnings below.
      const hashPrefix = c.proof.stellar_tx_hash.slice(0, 8);
      const date = c.proof.canary_completed_at.slice(0, 10);
      line(
        `proof:    not current — canary ${hashPrefix} completed ${date}; amounts capped at ${cap}`,
      );
    } else {
      line(`proof:    none — amounts capped at ${cap}`);
    }
  } else if (live.state === "unverified") {
    line("liveness: ? UNVERIFIED — endpoints present but unconfirmed. NOT runnable.");
  } else {
    line("liveness: ✗ NOT RUNNABLE — a required endpoint is missing.");
  }

  if (live.warnings.length > 0) {
    line();
    line("liveness warnings:");
    for (const w of live.warnings) line(`  ! ${w}`);
  }

  return lines.join("\n");
}

export type PlanArgs =
  | { readonly ok: true; readonly file: string; readonly json: boolean }
  | { readonly ok: false; readonly error: string };

/** Parse `plan` arguments: one manifest path plus an optional `--json`. */
export function parsePlanArgs(args: readonly string[]): PlanArgs {
  let json = false;
  const files: string[] = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (arg.startsWith("--")) {
      return { ok: false, error: `error: unknown option "${arg}"` };
    } else {
      files.push(arg);
    }
  }
  const [file] = files;
  if (!file) {
    return { ok: false, error: "usage: corridor plan <file.corridor.yaml> [--json]" };
  }
  if (files.length > 1) {
    return { ok: false, error: `error: unexpected argument "${files[1]}"` };
  }
  return { ok: true, file, json };
}
