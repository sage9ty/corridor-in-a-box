// Fixture for loadResolver(): declares apiVersion but has no default export —
// the loader must name the missing factory rather than produce a confusing
// downstream error.

import { ROUTE_RESOLVER_API_VERSION } from "@corridor/router";

export const apiVersion = ROUTE_RESOLVER_API_VERSION;
