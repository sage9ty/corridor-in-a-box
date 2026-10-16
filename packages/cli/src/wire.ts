import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Networks } from "@stellar/stellar-sdk";
import type { Corridor } from "@corridor/manifest";
import { liveness } from "@corridor/manifest";
import { Sep31Adapter, sep31GateChecks } from "@corridor/sep31";
import {
  LocalKeypairSigner,
  StellarSep10Signer,
  StellarSettlementSubmitter,
  AccountInspector,
  balanceCheck,
  type ExternalSigner,
  type AccountInspectorLike,
  type BalanceCheckOptions,
} from "@corridor/stellar";
import { RegistryRouteResolver, type AttestationSource } from "@corridor/router";
import { AnchorRegistry } from "@corridor/registry";
import {
  CompositeGate,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  consoleLogger,
  execute,
  type EngineDeps,
  type GateCheck,
  type RunResult,
  type SettlementRequest,
} from "@corridor/engine";
import { compareAmounts, type Outcome, type PaymentIntent } from "@corridor/types";
import deploymentsData from "../../../contracts/deployments.json";

// Exit codes mirroring docs/operations.md:150-153 and verify:corridor
export const EXIT_OK = 0;
export const EXIT_MANIFEST = 1;
export const EXIT_MISSING_ENV = 2;
export const EXIT_REFUSED = 3;
export const EXIT_STACK_UNFIT = 4;
export const EXIT_NOT_COMPLETED = 5;

/** Default ceiling for canary payments when corridor proof.canary_max_amount is unset. */
export const DEFAULT_CANARY_MAX_AMOUNT = "10.00";

interface DeploymentConfig {
  networkPassphrase?: string;
  rpcUrl?: string;
  registry?: string | null;
  attester?: string | null;
}

export interface DoctorOptions {
  scriptPath?: string;
  skipDoctor?: boolean;
}

/** `reference-anchor.sh doctor`, so "the stack is not up" is a named failure up front. */
export function preflightDoctor(opts: DoctorOptions = {}): {
  ok: boolean;
  status?: number;
  error?: string;
} {
  if (opts.skipDoctor ?? process.env.SKIP_DOCTOR === "1") {
    console.log("• preflight: skipped (SKIP_DOCTOR=1)\n");
    return { ok: true };
  }
  const script =
    opts.scriptPath ??
    fileURLToPath(new URL("../../../scripts/reference-anchor.sh", import.meta.url));
  const run = spawnSync(script, ["doctor"], { stdio: "inherit" });
  if (run.error) {
    return { ok: false, error: `could not run ${script}: ${run.error.message}` };
  }
  if (run.status !== 0) {
    return { ok: false, status: run.status ?? 1 };
  }
  console.log();
  return { ok: true };
}

/** Trim trailing "/" without a backtracking regex (avoids polynomial ReDoS). */
function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

function stripSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

/**
 * Checks whether the anchor quotes the corridor's bridge asset.
 */
export async function assertAssetQuotable(
  corridor: Corridor,
  anchorUrl?: string,
): Promise<{ ok: boolean; error?: string; refused?: boolean }> {
  const issuer = corridor.settlement.asset_issuer;
  if (!issuer) return { ok: true };
  const code = corridor.settlement.bridge_asset;
  const want = `stellar:${code}:${issuer}`;

  const destEndpoints = corridor.dest.endpoints as {
    quote_server?: string;
    transfer_server_sep31?: string;
    kyc_server?: string;
  };
  const quoteServer =
    anchorUrl ??
    destEndpoints.quote_server ??
    (destEndpoints.transfer_server_sep31
      ? stripSuffix(stripTrailingSlashes(destEndpoints.transfer_server_sep31), "/sep31")
      : undefined);

  if (!quoteServer && corridor.fx.quote_source !== "sep38") {
    return { ok: true };
  }

  const base = stripTrailingSlashes(quoteServer ?? "http://localhost:8080");
  const infoUrl = base.endsWith("/sep38") ? `${base}/info` : `${base}/sep38/info`;

  let body: { assets?: { asset?: string }[] };
  try {
    const res = await fetch(infoUrl);
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} from ${infoUrl}` };
    }
    body = (await res.json()) as { assets?: { asset?: string }[] };
  } catch (e) {
    return { ok: false, error: `could not read ${infoUrl}: ${String(e)}` };
  }

  const assets = (body.assets ?? []).map((a) => a.asset ?? "");
  if (assets.includes(want)) return { ok: true };

  const sameCode = assets.filter((a) => a.startsWith(`stellar:${code}:`));
  const detail =
    sameCode.length > 0
      ? `It quotes: ${sameCode.join(", ")}. Set settlement.asset_issuer in manifest to one of those issuers.`
      : `It quotes no ${code} at all. Available: ${assets.join(", ") || "(none)"}`;
  return { ok: false, refused: true, error: `${base} does not quote ${want}.\n  ${detail}` };
}

/** Point destination endpoints at a reference server. */
export function pinToReferenceAnchor(corridor: Corridor, anchorUrl?: string): Corridor {
  const anchor = stripTrailingSlashes(
    anchorUrl ?? process.env.REFERENCE_ANCHOR_URL ?? "http://localhost:8080",
  );
  const host = anchor.replace(/^https?:\/\//, "");
  return {
    ...corridor,
    dest: {
      ...corridor.dest,
      protocol: "sep31" as const,
      endpoints: {
        ...corridor.dest.endpoints,
        home_domain: host,
        transfer_server_sep31: `${anchor}/sep31`,
        web_auth: `${anchor}/auth`,
        kyc_server: `${anchor}/sep12`,
        quote_server: `${anchor}/sep38`,
      },
    },
  };
}

/** Construct the default pre-settle gate (account balance check). */
export function createDefaultGate(
  inspector: AccountInspectorLike,
  signerPublicKey: string,
  opts?: BalanceCheckOptions,
  extraChecks: readonly GateCheck[] = [],
): CompositeGate {
  return new CompositeGate([balanceCheck(inspector, signerPublicKey, opts), ...extraChecks]);
}

export interface ResolverWiringOptions {
  signer: ExternalSigner;
  network?: "public" | "testnet";
  rpcUrl?: string;
  contractId?: string;
  networkPassphrase?: string;
  allowUnattestedDomains?: readonly string[];
  maxStalenessLedgers?: number;
}

/** Create a RegistryRouteResolver wired from config or environment. */
export function createRegistryRouteResolver(
  corridor: Corridor,
  opts: ResolverWiringOptions,
): RegistryRouteResolver {
  const network = opts.network ?? corridor.settlement.network;
  const deployments = deploymentsData as Record<string, DeploymentConfig>;
  const cfg = deployments[network];

  const rpcUrl =
    opts.rpcUrl ??
    process.env.SOROBAN_RPC_URL ??
    cfg?.rpcUrl ??
    "https://soroban-testnet.stellar.org";
  const contractId =
    opts.contractId ?? process.env.REGISTRY_CONTRACT_ID ?? cfg?.registry ?? undefined;
  const networkPassphrase =
    opts.networkPassphrase ??
    process.env.STELLAR_NETWORK_PASSPHRASE ??
    cfg?.networkPassphrase ??
    (network === "public" ? Networks.PUBLIC : Networks.TESTNET);

  let attestationSource: AttestationSource;
  if (contractId) {
    attestationSource = new AnchorRegistry({
      rpcUrl,
      contractId,
      networkPassphrase,
    });
  } else {
    attestationSource = {
      async servesSep31(_d: string): Promise<boolean> {
        throw new Error(
          `no registry deployed on ${network} (see contracts/deployments.json or set REGISTRY_CONTRACT_ID)`,
        );
      },
      async staleness(_d: string): Promise<number> {
        throw new Error(`no registry deployed on ${network}`);
      },
      async tomlHash(_d: string): Promise<string> {
        throw new Error(`no registry deployed on ${network}`);
      },
    };
  }

  const envUnattested = process.env.ALLOW_UNATTESTED_DOMAINS
    ? process.env.ALLOW_UNATTESTED_DOMAINS.split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  const defaultUnattested = ["localhost", "localhost:8080", "127.0.0.1", "127.0.0.1:8080"];

  const refUrl = process.env.REFERENCE_ANCHOR_URL;
  if (refUrl) {
    try {
      const u = new URL(refUrl);
      defaultUnattested.push(u.host, u.hostname);
    } catch {
      defaultUnattested.push(refUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    }
  }

  const allowed = Array.from(
    new Set([...defaultUnattested, ...envUnattested, ...(opts.allowUnattestedDomains ?? [])]),
  );

  return new RegistryRouteResolver({
    registry: attestationSource,
    adapterFor: (c) => new Sep31Adapter(c, { sep10: new StellarSep10Signer(opts.signer) }),
    allowUnattestedDomains: allowed,
    maxStalenessLedgers: opts.maxStalenessLedgers,
  });
}

/** Register a customer under SEP-12. */
export async function registerSep12Customer(
  adapter: Sep31Adapter,
  role: "receiver" | "sender",
  type: string,
): Promise<Outcome<string>> {
  return adapter.registerCustomer(
    {
      first_name: "Alice",
      last_name: "Example",
      email_address: `${role}@example.com`,
      bank_account_number: "12345678901234",
      bank_number: "021000021",
      bank_account_type: "checking",
      clabe_number: "032180000118359719",
    },
    { type },
  );
}

export interface WireDepsOptions {
  signerSecret?: string;
  horizonUrl?: string;
  rpcUrl?: string;
  contractId?: string;
  allowUnattestedDomains?: readonly string[];
  stallThreshold?: number;
  reconcilePollMs?: number;
}

export interface WiredCorridor {
  deps: EngineDeps;
  signer: LocalKeypairSigner;
  adapter: Sep31Adapter;
  submitter: StellarSettlementSubmitter;
  resolver: RegistryRouteResolver;
  gate: CompositeGate;
  store: InMemoryIdempotencyStore;
  audit: InMemoryAuditLog;
  horizonUrl: string;
}

/**
 * Shared wiring module: wires Sep31Adapter + StellarSettlementSubmitter +
 * the default gate (balanceCheck) + RegistryRouteResolver from env.
 */
export function wireCorridorDeps(
  corridor: Corridor,
  opts: WireDepsOptions = {},
): WiredCorridor {
  const secret = opts.signerSecret ?? process.env.CORRIDOR_SIGNER_SECRET;
  if (!secret) {
    throw new Error("missing required env var CORRIDOR_SIGNER_SECRET");
  }
  const horizonUrl =
    opts.horizonUrl ??
    process.env.HORIZON_URL ??
    (corridor.settlement.network === "public"
      ? "https://horizon.stellar.org"
      : "https://horizon-testnet.stellar.org");

  const signer = LocalKeypairSigner.fromSecret(secret);
  const adapter = new Sep31Adapter(corridor, { sep10: new StellarSep10Signer(signer) });
  const audit = new InMemoryAuditLog();
  const store = new InMemoryIdempotencyStore();

  const inspector = new AccountInspector({ horizonUrl });
  const gate = createDefaultGate(
    inspector,
    signer.publicKey,
    undefined,
    sep31GateChecks(adapter),
  );

  const resolver = createRegistryRouteResolver(corridor, {
    signer,
    network: corridor.settlement.network,
    rpcUrl: opts.rpcUrl,
    contractId: opts.contractId,
    allowUnattestedDomains: opts.allowUnattestedDomains,
  });

  const submitter = new StellarSettlementSubmitter({
    signer,
    horizonUrl,
  });

  const deps: EngineDeps = {
    resolver,
    submitter,
    gate,
    idempotency: store,
    audit,
    logger: consoleLogger,
    trustManifestWithoutAttestation: true,
    stallThreshold: opts.stallThreshold,
    reconcilePollMs: opts.reconcilePollMs,
  };

  return { deps, signer, adapter, submitter, resolver, gate, store, audit, horizonUrl };
}

export interface ExecuteCanaryOptions {
  amount: string;
  network?: string;
  skipDoctor?: boolean;
  anchorUrl?: string;
  idempotencyKey?: string;
}

export interface CanaryRunResult {
  exitCode: number;
  trail?: readonly string[];
  transactionId?: string;
  stellarTxHash?: string;
  error?: string;
  /** Terminal run result and the settlement the submitter was asked to make; set on a completed run. */
  run?: RunResult;
  settlement?: SettlementRequest;
  horizonUrl?: string;
}

/**
 * Execute a gated canary payment through the real stack.
 */
export async function executeCanary(
  corridor: Corridor,
  opts: ExecuteCanaryOptions,
): Promise<CanaryRunResult> {
  // 1. Liveness check: must be verified
  const live = liveness(corridor);
  if (live.state !== "verified") {
    const reason =
      live.state === "unverified"
        ? "endpoints present but unconfirmed. NOT runnable."
        : "a required endpoint is missing.";
    console.error(
      `✗ corridor "${corridor.id}" liveness is ${live.state.toUpperCase()} (${reason}) must be VERIFIED to run canary.`,
    );
    return { exitCode: EXIT_REFUSED, error: `liveness is ${live.state}` };
  }

  // 2. Mainnet check: requires --network public
  if (corridor.settlement.network === "public" && opts.network !== "public") {
    console.error(
      `✗ corridor "${corridor.id}" settles on MAINNET (network=public). Pass --network public explicitly to run on mainnet.`,
    );
    return { exitCode: EXIT_REFUSED, error: "mainnet requires --network public" };
  }
  if (corridor.settlement.network === "testnet" && opts.network === "public") {
    console.error(
      `✗ corridor "${corridor.id}" settles on TESTNET (network=testnet), but --network public was passed.`,
    );
    return { exitCode: EXIT_REFUSED, error: "network mismatch" };
  }

  // 3. Canary cap check: amount <= proof.canary_max_amount (or default)
  const cap = corridor.proof?.canary_max_amount ?? DEFAULT_CANARY_MAX_AMOUNT;
  const cmp = compareAmounts(opts.amount, cap);
  if (!cmp.ok || cmp.value > 0) {
    console.error(
      `✗ amount "${opts.amount}" exceeds canary cap "${cap}" (corridor ${corridor.id})`,
    );
    return { exitCode: EXIT_REFUSED, error: `amount exceeds canary cap ${cap}` };
  }

  // 4. Distribution signer secret
  const secret = process.env.CORRIDOR_SIGNER_SECRET;
  if (!secret) {
    console.error("✗ missing required env var CORRIDOR_SIGNER_SECRET");
    console.error("  A testnet distribution account seed. Never a mainnet seed — see");
    console.error("  docs/key-management.md.");
    return { exitCode: EXIT_MISSING_ENV, error: "missing CORRIDOR_SIGNER_SECRET" };
  }

  // 5. Preflight if targeting local reference anchor
  const destDomain = corridor.dest.endpoints.home_domain;
  const isLocalAnchor =
    destDomain.startsWith("localhost") ||
    destDomain.startsWith("127.0.0.1") ||
    Boolean(process.env.REFERENCE_ANCHOR_URL);

  if (isLocalAnchor) {
    const doc = preflightDoctor({ skipDoctor: opts.skipDoctor });
    if (!doc.ok) {
      if (doc.error) {
        console.error(`✗ ${doc.error}`);
      } else {
        console.error(
          `\n✗ the reference anchor is not fit to run a corridor (doctor exit ${doc.status}).`,
        );
      }
      return { exitCode: EXIT_STACK_UNFIT, error: "doctor check failed" };
    }

    const quotable = await assertAssetQuotable(corridor, opts.anchorUrl);
    if (!quotable.ok) {
      console.error(`✗ ${quotable.error}`);
      return {
        exitCode: quotable.refused ? EXIT_REFUSED : EXIT_STACK_UNFIT,
        error: quotable.error,
      };
    }
  }

  // 6. Wire real stack
  const wired = wireCorridorDeps(corridor, { signerSecret: secret });
  const { signer, adapter, store, audit, horizonUrl } = wired;

  // Capture the settlement request the engine submits, so `--write` can
  // re-verify exactly that payment on chain before recording a proof.
  let settlement: SettlementRequest | undefined;
  const deps: EngineDeps = {
    ...wired.deps,
    submitter: {
      submit: async (request) => {
        settlement = request;
        return wired.deps.submitter.submit(request);
      },
      refund: (request) => wired.deps.submitter.refund(request),
    },
  };

  // 7. SEP-12 customer identification
  let senderSep12Id = process.env.SENDER_SEP12_ID;
  let recipientSep12Id = process.env.RECIPIENT_SEP12_ID;

  if ((corridor.dest.endpoints as { kyc_server?: string }).kyc_server) {
    if (!senderSep12Id) {
      console.log("registering sender (SEP-12)…");
      const reg = await registerSep12Customer(
        adapter,
        "sender",
        corridor.compliance.sep12_sender_type,
      );
      if (!reg.ok) {
        console.error(
          `✗ SEP-12 sender registration failed: ${reg.error.code} — ${reg.error.message}`,
        );
        return { exitCode: EXIT_NOT_COMPLETED, error: reg.error.message };
      }
      console.log(`  sender: ${reg.value}`);
      senderSep12Id = reg.value;
    }

    if (!recipientSep12Id) {
      console.log("registering receiver (SEP-12)…");
      const reg = await registerSep12Customer(
        adapter,
        "receiver",
        corridor.compliance.sep12_receiver_type,
      );
      if (!reg.ok) {
        console.error(
          `✗ SEP-12 receiver registration failed: ${reg.error.code} — ${reg.error.message}`,
        );
        return { exitCode: EXIT_NOT_COMPLETED, error: reg.error.message };
      }
      console.log(`  receiver: ${reg.value}`);
      recipientSep12Id = reg.value;
    }
  }

  // 8. Intent
  const intent: PaymentIntent = {
    idempotencyKey:
      opts.idempotencyKey ??
      process.env.IDEMPOTENCY_KEY ??
      `canary-${corridor.id}-${Date.now()}`,
    corridorId: corridor.id,
    sender: {
      id: "canary-sender",
      jurisdiction: corridor.compliance.source_jurisdiction,
      sep12Id: senderSep12Id,
    },
    recipient: {
      id: "canary-recipient",
      jurisdiction: corridor.compliance.dest_jurisdiction,
      sep12Id: recipientSep12Id,
    },
    sourceAmount: {
      asset: corridor.settlement.bridge_asset,
      amount: opts.amount,
    },
    destinationFields: {
      receiver_routing_number: "021000021",
      receiver_account_number: "12345678901234",
      type: "SWIFT",
    },
  };

  console.log(`\nrunning canary for corridor "${corridor.id}"`);
  console.log(`  signer:  ${signer.publicKey}`);
  console.log(`  horizon: ${horizonUrl}`);
  console.log(
    `  intent:  ${intent.idempotencyKey} (${opts.amount} ${corridor.settlement.bridge_asset})\n`,
  );

  const result = await execute(intent, corridor, deps);

  const trail =
    audit.entries.length > 0
      ? [audit.entries[0].from, ...audit.entries.map((e) => e.to)]
      : ((result.ok ? result.value.trail : []) as readonly string[]);
  const stored = await store.get(intent.idempotencyKey);

  console.log(`\ntrail: ${trail.join(" -> ")}`);
  const txId = stored?.transactionId ?? (result.ok ? result.value.transactionId : undefined);
  if (txId) {
    console.log(`transaction id: ${txId}`);
  }
  const stellarTx =
    stored?.stellarTxHash ?? (result.ok ? result.value.stellarTxHash : undefined);
  if (stellarTx) {
    console.log(`stellar tx:     ${stellarTx}`);
    console.log(
      `explorer:       https://stellar.expert/explorer/${corridor.settlement.network}/tx/${stellarTx}`,
    );
  }

  if (!result.ok) {
    console.error(`\n✗ ${result.error.code} — ${result.error.message}`);
    console.error(`  terminal state: ${stored?.state ?? "unknown"}`);
    return {
      exitCode: EXIT_NOT_COMPLETED,
      trail,
      transactionId: txId,
      stellarTxHash: stellarTx,
      error: `${result.error.code}: ${result.error.message}`,
    };
  }

  if (result.value.state !== "completed") {
    console.error(`\n✗ terminal state is "${result.value.state}", not "completed"`);
    if (stored?.lastError) console.error(`  last error: ${stored.lastError}`);
    return {
      exitCode: EXIT_NOT_COMPLETED,
      trail,
      transactionId: txId,
      stellarTxHash: stellarTx,
      error: `terminal state: ${result.value.state}`,
    };
  }

  console.log(`\n✓ corridor canary completed end to end`);
  console.log(`  ${audit.entries.length} transitions recorded`);
  return {
    exitCode: EXIT_OK,
    trail,
    transactionId: txId,
    stellarTxHash: stellarTx,
    run: result.value,
    settlement,
    horizonUrl,
  };
}
