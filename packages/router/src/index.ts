// @corridor/router — the RouteResolver seam drawn in code.
//
// The interface and two open resolvers ship here: StaticRouteResolver (trust the
// manifest) and RegistryRouteResolver (require a fresh on-chain attestation). A
// resolver weighted by anchor health, conformance, latency, and proprietary
// routing data could be supplied separately in the future; no such proprietary
// component is included or injected here.

import type { Corridor } from "@corridor/manifest";
import type { AnchorAdapter, SourceAnchorAdapter } from "@corridor/adapter-kit";
import type { PaymentIntent } from "@corridor/types";

export interface RouteDecision {
  /** The receiving anchor chosen for this payment. */
  readonly receiving: AnchorAdapter;
  /** Sending anchor used to on-ramp funds for non-prefunded corridors. */
  readonly sending?: SourceAnchorAdapter;
  /**
   * Reserved for split routing across multiple anchors (weights sum to 1).
   * The engine ignores this field today and reads only `receiving`, so setting
   * it does not change where a payment goes. See docs/route-resolver.md#split.
   */
  readonly split?: ReadonlyArray<{ adapter: AnchorAdapter; weight: number }>;
  /** How the route decision was reached: verified against on-chain evidence or assumed from manifest. */
  readonly trust: "attested" | "manifest";
}

/**
 * Chooses the receiving anchor for a payment. This is the open/closed seam.
 *
 * The engine may call `resolve()` more than once for the same payment (on the
 * first run and again on resume), so the result should be stable for the same
 * inputs. `resolve()` may throw to fail closed: `RegistryRouteResolver` throws
 * `UnattestedAnchorError` rather than return a route it cannot vouch for. The
 * full contract is in docs/route-resolver.md#the-routeresolver-interface.
 */
export interface RouteResolver {
  resolve(intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision>;
}

export interface StaticRouteResolverOptions {
  readonly trustManifestWithoutAttestation?: boolean;
  readonly sourceAdapterFor?: (corridor: Corridor) => SourceAnchorAdapter;
}

/**
 * Default resolver: use the single anchor the manifest declares. No intelligence.
 * Swap this out for another RouteResolver implementation if one is developed;
 * the interface is an extension seam, not evidence of a separate closed repo.
 */
export class StaticRouteResolver implements RouteResolver {
  constructor(
    private readonly adapterFor: (corridor: Corridor) => AnchorAdapter,
    private readonly options?: StaticRouteResolverOptions,
  ) {
    if (!options?.trustManifestWithoutAttestation) {
      throw new Error(
        "StaticRouteResolver requires explicit { trustManifestWithoutAttestation: true }. Use RegistryRouteResolver for verified routing.",
      );
    }
  }

  async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
    const sending = this.options?.sourceAdapterFor?.(corridor);
    return {
      receiving: this.adapterFor(corridor),
      ...(sending ? { sending } : {}),
      trust: "manifest",
    };
  }
}

// The registry-backed resolver: the evidence-based resolver, in code.
// StaticRouteResolver above trusts the manifest; this one requires evidence.
export {
  RegistryRouteResolver,
  UnattestedAnchorError,
  asAttestationSource,
  isAttestedProtocol,
  isUnattestedDomainAllowed,
  type AttestationSource,
  type AttestationSourceLike,
  type AttestedProtocol,
  type LegacyAttestationSource,
  type RegistryResolverOptions,
} from "./registry-resolver";

// Deploy-time injection: load a RouteResolver module named in config (e.g.
// CORRIDOR_RESOLVER_MODULE) instead of editing code. The module below the
// seam stays private; the seam itself stays open.
export {
  loadResolver,
  ResolverLoadError,
  ROUTE_RESOLVER_API_VERSION,
  type LoadResolverSpec,
  type LoadResolverCtx,
} from "./load";

export { createAdapterRegistry } from "./adapters";
export type { AdapterFactory, AdapterRegistry } from "./adapters";
