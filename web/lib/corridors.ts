// Corridor data for the demo UI. Nothing here is hand-copied: the manifests come
// from lib/generated/corridors.json, written by `pnpm gen:web-data` from
// ../corridors/*.corridor.yaml and checked for drift in CI, and liveness() is the
// manifest package's own function, so the site and the CLI cannot disagree about
// whether a lane is runnable.

import type { Corridor } from "@corridor/manifest";
// The subpath, not the package root: this module is imported by client
// components, and the root also exports the fs-backed manifest loader.
import {
  liveness,
  LIVENESS_LABEL,
  type Liveness,
  type LivenessState,
} from "@corridor/manifest/liveness";
import generated from "./generated/corridors.json";

export type { Corridor, Liveness, LivenessState };
export { liveness, LIVENESS_LABEL };

// The JSON is parseCorridor() output, but its inferred type widens literals
// such as `protocol` to string, so it is cast rather than re-validated here.
export const corridors = generated as unknown as Corridor[];

export function getCorridor(id: string): Corridor | undefined {
  return corridors.find((c) => c.id === id);
}

/** Endpoint fields the corridor page tabulates, across every anchor protocol. */
export type EndpointKey =
  | "home_domain"
  | "transfer_server_sep31"
  | "transfer_server"
  | "web_auth"
  | "kyc_server"
  | "quote_server";

/** One endpoint of an anchor, or undefined when that anchor's protocol has no such field. */
export function endpoint(
  endpoints: Corridor["source"]["endpoints"] | Corridor["dest"]["endpoints"],
  key: EndpointKey,
): string | undefined {
  const value = (endpoints as Partial<Record<EndpointKey, unknown>> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

export const VERBS = [
  { step: 1, verb: "quote", sep: "SEP-38  POST /quote" },
  { step: 2, verb: "comply", sep: "SEP-10 auth + SEP-12 KYC handoff" },
  { step: 3, verb: "open", sep: "SEP-31  POST /transactions" },
  { step: 4, verb: "settle", sep: "native Stellar payment of bridge asset" },
  { step: 5, verb: "reconcile", sep: "SEP-31  GET /transactions/:id" },
] as const;
