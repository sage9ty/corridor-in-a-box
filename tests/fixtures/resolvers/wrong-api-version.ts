// Fixture for loadResolver(): a module built against a different loader
// contract. The loader must refuse it by name rather than guess.

import { ROUTE_RESOLVER_API_VERSION, type RouteResolver } from "@corridor/router";

export const apiVersion = ROUTE_RESOLVER_API_VERSION + 1;

export default function createWrongVersionResolver(): RouteResolver {
  return {
    async resolve() {
      throw new Error("unreachable: the loader refuses this module on apiVersion alone");
    },
  };
}
