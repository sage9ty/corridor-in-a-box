// allowlist-resolver — a worked example of a RouteResolver that lives OUTSIDE
// @corridor/router. Contributors and future private-resolver authors can read
// this file top to bottom and see the whole plugin shape end to end: the
// `apiVersion` declaration, the default-exported factory, and the resolve()
// implementation loadResolver() expects (see docs/route-resolver.md).
//
// What it does: GATES on top of another resolver. A corridor whose
// dest.endpoints.home_domain is not on the operator's allowlist is refused
// before anything else runs; a domain that is on the list is delegated to the
// wrapped resolver — RegistryRouteResolver by default, so the allowlist is an
// extra door, not a replacement for the attestation evidence check.
//
// What it deliberately does NOT do: health scoring, rate weighting, or split
// routing. It only narrows which corridors a payment may travel through at
// all, leaving every routing *decision* to the resolver underneath.
//
// Run it with:
//   CORRIDOR_RESOLVER_MODULE=./examples/resolvers/allowlist-resolver.ts \
//   CORRIDOR_RESOLVER_OPTIONS='{"domains":["localhost:8080"]}' pnpm serve

import {
  RegistryRouteResolver,
  ROUTE_RESOLVER_API_VERSION,
  type AttestationSource,
  type AttestationSourceLike,
  type LoadResolverCtx,
  type RouteDecision,
  type RouteResolver,
} from "@corridor/router";
import type { Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

export const apiVersion = ROUTE_RESOLVER_API_VERSION;

/** A corridor whose destination is not on the operator's allowlist. */
export class DomainNotAllowedError extends Error {
  constructor(
    readonly domain: string,
    readonly allowlist: readonly string[],
  ) {
    super(
      `refusing to route to ${domain}: not on the operator allowlist ` +
        `(${allowlist.length} domain${allowlist.length === 1 ? "" : "s"} allowed)`,
    );
    this.name = "DomainNotAllowedError";
  }
}

export interface AllowlistResolverOptions {
  /** Destination home domains a payment may be routed to. Required. */
  readonly domains?: readonly string[];
  /** Alias for `domains`. */
  readonly allowlist?: readonly string[];
  /**
   * Wrap this resolver instead of the default RegistryRouteResolver. The env
   * path (`CORRIDOR_RESOLVER_OPTIONS`) is JSON and cannot carry functions, so
   * this exists for programmatic callers and tests; leave it unset in a deploy.
   */
  readonly wrap?: RouteResolver;
  /**
   * Attestation source for the default RegistryRouteResolver. Either shape is
   * accepted: a source that can only answer the SEP-31 question is adapted and
   * answers `false` for every other protocol, so it can never wave a SEP-6
   * lane through.
   */
  readonly registry?: AttestationSourceLike;
  readonly maxStalenessLedgers?: number;
  /** Passed through to the default RegistryRouteResolver. */
  readonly allowUnattestedDomains?: readonly string[];
}

/** Straight from @corridor/cli wire.ts: a self-hosted reference anchor can never
 *  be attested by a public attester, and that fact must not be mistaken for a
 *  reason to skip the allowlist in front of it. */
const LOCAL_UNATTESTED = ["localhost", "localhost:8080", "127.0.0.1", "127.0.0.1:8080"];

/** The gate itself: refuse everything the operator did not name, forward
 *  everything they did — to the wrapped resolver, which keeps its own say. */
class AllowlistResolver implements RouteResolver {
  private readonly allowed: ReadonlySet<string>;

  constructor(
    private readonly inner: RouteResolver,
    allowlist: readonly string[],
  ) {
    this.allowed = new Set(allowlist);
  }

  async resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    const domain = corridor.dest.endpoints.home_domain;
    if (!this.allowed.has(domain)) {
      throw new DomainNotAllowedError(domain, [...this.allowed]);
    }
    return this.inner.resolve(intent, corridor);
  }
}

/**
 * Where the default RegistryRouteResolver reads attestations from: the
 * on-chain registry when a contract id is configured, and otherwise a source
 * that throws on every question — RegistryRouteResolver then fails CLOSED,
 * which is the only safe default for an unconfigured deployment.
 */
async function defaultRegistry(): Promise<AttestationSource> {
  const contractId = process.env.REGISTRY_CONTRACT_ID;
  if (contractId) {
    const { AnchorRegistry } = await import("@corridor/registry");
    return new AnchorRegistry({
      rpcUrl: process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org",
      contractId,
      networkPassphrase:
        process.env.STELLAR_NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
    });
  }
  const reason =
    "no registry configured (set REGISTRY_CONTRACT_ID; see contracts/deployments.json)";
  return {
    serves: async (): Promise<boolean> => {
      throw new Error(reason);
    },
    staleness: async (): Promise<number> => {
      throw new Error(reason);
    },
    tomlHash: async (): Promise<string> => {
      throw new Error(reason);
    },
  };
}

function localUnattested(): string[] {
  const out = [...LOCAL_UNATTESTED];
  const refUrl = process.env.REFERENCE_ANCHOR_URL;
  if (refUrl) {
    try {
      const u = new URL(refUrl);
      out.push(u.host, u.hostname);
    } catch {
      out.push(refUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    }
  }
  return out;
}

/**
 * The factory loadResolver() calls: `(ctx, options) => RouteResolver`.
 *
 * `ctx.adapterFor` is the only thing the loader hands it — everything else
 * arrives as `options` (from `CORRIDOR_RESOLVER_OPTIONS` when launched through
 * `pnpm serve`), so the module stays a plain file a human can audit before a
 * restart.
 */
export default async function createAllowlistResolver(
  ctx: LoadResolverCtx,
  options?: AllowlistResolverOptions,
): Promise<RouteResolver> {
  const raw = options?.domains ?? options?.allowlist;
  const allowlist = (Array.isArray(raw) ? raw : [])
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);
  if (allowlist.length === 0) {
    throw new Error(
      'allowlist-resolver: empty allowlist — set CORRIDOR_RESOLVER_OPTIONS, e.g. {"domains":["testanchor.stellar.org"]}',
    );
  }

  const inner =
    options?.wrap ??
    new RegistryRouteResolver({
      registry: options?.registry ?? (await defaultRegistry()),
      adapterFor: ctx.adapterFor,
      maxStalenessLedgers: options?.maxStalenessLedgers,
      allowUnattestedDomains: [
        ...new Set([...localUnattested(), ...(options?.allowUnattestedDomains ?? [])]),
      ],
    });

  return new AllowlistResolver(inner, allowlist);
}
