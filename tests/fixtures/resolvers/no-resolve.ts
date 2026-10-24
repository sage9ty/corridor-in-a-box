// Fixture for loadResolver(): the factory returns the wrong shape — an object
// with no resolve() — so the loader's structural check is what must refuse it.

import { ROUTE_RESOLVER_API_VERSION } from "@corridor/router";

export const apiVersion = ROUTE_RESOLVER_API_VERSION;

export default function createShapelessResolver() {
  return { notResolve: () => "not a RouteResolver" };
}
