// Fixture for loadResolver(): the happy shape a module must have —
// apiVersion declared, default-exported factory, object with resolve().

import { ROUTE_RESOLVER_API_VERSION } from "@corridor/router";
import type { LoadResolverCtx, RouteDecision, RouteResolver } from "@corridor/router";
import type { Corridor } from "@corridor/manifest";
import type { PaymentIntent } from "@corridor/types";

export const apiVersion = ROUTE_RESOLVER_API_VERSION;

export default function createFixtureResolver(
  ctx: LoadResolverCtx,
  options?: { trust?: "manifest" | "attested" },
): RouteResolver {
  return {
    async resolve(_intent: PaymentIntent, corridor: Corridor): Promise<RouteDecision> {
      return { receiving: ctx.adapterFor(corridor), trust: options?.trust ?? "manifest" };
    },
  };
}
