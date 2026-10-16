// RegistryRouteResolver — refuse to route through an anchor nobody has checked.
//
// This is where the RouteResolver seam becomes code.
//
//   OPEN (here)         Does this anchor demonstrably work, and how recently was
//                       that established? Facts, read from the on-chain registry.
//   NOT INCLUDED        Which of several working anchors should this payment go
//                       through? Health scoring, rate weighting, split routing.
//                       Not part of this repo; a resolver like that could be
//                       supplied separately through the same interface.
//
// This resolver is a GATE, not a chooser: it answers yes/no on evidence and
// nothing more. That is deliberate — a gate is exactly the piece that has to be
// auditable, because it is what stands between an operator and settling into a
// lane that does not exist.
//
// It is also the engine-side counterpart to the dashboard fix. The dashboard
// stopped *displaying* unverified anchors as healthy; this stops the engine
// *settling* through them.

import type { Corridor } from "@corridor/manifest";
import type { AnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";
import type { RouteDecision, RouteResolver } from "./index";

/** The subset of @corridor/registry this resolver needs. Declared structurally
 *  so @corridor/router does not take a dependency on a Soroban SDK — an engine
 *  embedder who supplies their own attestation source should not have to. */
export interface AttestationSource {
  servesSep31(domain: string): Promise<boolean>;
  staleness(domain: string): Promise<number>;
  tomlHash(domain: string): Promise<string>;
}

export function isUnattestedDomainAllowed(
  domain: string,
  allowUnattestedDomains: readonly string[] = [],
): boolean {
  return allowUnattestedDomains.includes(domain);
}

export class UnattestedAnchorError extends Error {
  constructor(
    readonly domain: string,
    readonly reason: string,
  ) {
    super(`refusing to route through ${domain}: ${reason}`);
    this.name = "UnattestedAnchorError";
  }
}

export interface RegistryResolverOptions {
  /** Where attestations are read from. */
  registry: AttestationSource;
  /** Adapter to use once an anchor clears the gate. */
  adapterFor: (corridor: Corridor) => AnchorAdapter;
  /**
   * How old an attestation may be and still count as evidence, in ledgers.
   * Default ~1 week at 5s ledgers.
   *
   * There is no "no maximum" option on purpose. An attestation from six months
   * ago is not evidence about today, and an operator who forgets to bound
   * freshness rebuilds precisely the failure this component exists to prevent.
   */
  maxStalenessLedgers?: number;
  /**
   * Escape hatch for lanes with no attestation yet — e.g. a self-hosted
   * reference server on localhost, which no public attester can see.
   *
   * Named for what it does. Anything vaguer ("strict: false") invites being
   * switched on to make an error go away, and the error is the feature.
   */
  allowUnattestedDomains?: readonly string[];
}

const WEEK_OF_LEDGERS = 120_960;

export class RegistryRouteResolver implements RouteResolver {
  private readonly registry: AttestationSource;
  private readonly adapterFor: (corridor: Corridor) => AnchorAdapter;
  private readonly maxStaleness: number;
  private readonly allowed: readonly string[];

  constructor(opts: RegistryResolverOptions) {
    this.registry = opts.registry;
    this.adapterFor = opts.adapterFor;
    this.maxStaleness = opts.maxStalenessLedgers ?? WEEK_OF_LEDGERS;
    this.allowed = opts.allowUnattestedDomains ?? [];
  }

  async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    const domain = corridor.dest.endpoints.home_domain;

    if (isUnattestedDomainAllowed(domain, this.allowed)) {
      return { receiving: this.adapterFor(corridor), trust: "attested" };
    }

    let serves: boolean;
    let staleness: number;
    try {
      [serves, staleness] = await Promise.all([
        this.registry.servesSep31(domain),
        this.registry.staleness(domain),
      ]);
    } catch (cause) {
      // Fail CLOSED. An unreachable registry means we do not know whether this
      // anchor works, and "we do not know" must never resolve to "proceed".
      throw new UnattestedAnchorError(
        domain,
        `registry lookup failed (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }

    if (!serves) {
      throw new UnattestedAnchorError(
        domain,
        "not attested as serving SEP-31 receive-side. Advertising SEP-31 in a " +
          "stellar.toml is not sufficient — the SEP-31 probe must also pass.",
      );
    }
    if (staleness > this.maxStaleness) {
      throw new UnattestedAnchorError(
        domain,
        `last attested ${staleness} ledgers ago, older than the ${this.maxStaleness} ` +
          `ledger limit. Re-attest before routing value through it.`,
      );
    }

    return { receiving: this.adapterFor(corridor), trust: "attested" };
  }
}
