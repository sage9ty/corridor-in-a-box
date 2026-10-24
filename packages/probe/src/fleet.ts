// Structured anchor fleet loader for `contracts/anchors.json`.
//
// `contracts/anchors.json` lists the anchor home domains that the scheduled
// attester probes. Each entry records curator-declared metadata (name, ISO
// countries, kind, directory/manifest source, date added) alongside the flat
// `domains` array consumed by the workflow and CLI scripts.
//
// Countries and `kind` here are curator-declared context, NOT attested facts —
// the on-chain registry records only what `@corridor/probe` actually observes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ANCHOR_KINDS = ["offramp", "test", "other"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export interface AnchorEntry {
  readonly domain: string;
  readonly name: string;
  readonly countries: readonly string[];
  readonly kind: AnchorKind;
  readonly source: string;
  readonly added: string;
}

export interface AnchorFleet {
  readonly $comment?: readonly string[];
  readonly domains: readonly string[];
  readonly anchors: readonly AnchorEntry[];
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

export function isValidAnchorDomain(domain: string): boolean {
  if (!domain || domain !== domain.toLowerCase()) return false;
  if (domain.includes("://") || domain.includes("/") || domain.includes(":")) return false;
  return DOMAIN_RE.test(domain);
}

/**
 * Parse and validate an `anchors.json` fleet object. Throws a descriptive
 * `Error` if the structure or any domain/entry invariant is violated.
 */
export function parseFleet(raw: unknown): AnchorFleet {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("invalid fleet: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.anchors) || obj.anchors.length === 0) {
    throw new Error("invalid fleet: 'anchors' must be a non-empty array");
  }

  const seen = new Set<string>();
  const entries: AnchorEntry[] = [];

  for (let i = 0; i < obj.anchors.length; i++) {
    const item = obj.anchors[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`invalid fleet: anchors[${i}] must be an object`);
    }
    const e = item as Record<string, unknown>;
    if (typeof e.domain !== "string" || !isValidAnchorDomain(e.domain)) {
      throw new Error(
        `invalid fleet: anchors[${i}].domain (${JSON.stringify(e.domain)}) must be a lowercase hostname with no scheme, port, or path`,
      );
    }
    if (seen.has(e.domain)) {
      throw new Error(`invalid fleet: duplicate anchor domain "${e.domain}"`);
    }
    seen.add(e.domain);

    if (typeof e.name !== "string" || e.name.trim().length === 0) {
      throw new Error(`invalid fleet: anchors[${i}].name must be a non-empty string`);
    }
    if (
      !Array.isArray(e.countries) ||
      !e.countries.every((c) => typeof c === "string" && COUNTRY_RE.test(c))
    ) {
      throw new Error(
        `invalid fleet: anchors[${i}].countries must be an array of ISO 3166-1 alpha-2 codes`,
      );
    }
    if (typeof e.kind !== "string" || !(ANCHOR_KINDS as readonly string[]).includes(e.kind)) {
      throw new Error(
        `invalid fleet: anchors[${i}].kind must be one of ${ANCHOR_KINDS.join(", ")}`,
      );
    }
    if (typeof e.source !== "string" || e.source.trim().length === 0) {
      throw new Error(`invalid fleet: anchors[${i}].source must be a non-empty string`);
    }
    if (typeof e.added !== "string" || !isRealCalendarDate(e.added)) {
      throw new Error(`invalid fleet: anchors[${i}].added must be a real YYYY-MM-DD date`);
    }

    entries.push({
      domain: e.domain,
      name: e.name,
      countries: e.countries as string[],
      kind: e.kind as AnchorKind,
      source: e.source,
      added: e.added,
    });
  }

  const derivedDomains = entries.map((a) => a.domain);
  if (obj.domains !== undefined) {
    if (
      !Array.isArray(obj.domains) ||
      obj.domains.length !== derivedDomains.length ||
      obj.domains.some((d, idx) => d !== derivedDomains[idx])
    ) {
      throw new Error(
        "invalid fleet: 'domains' must match the ordered list of 'anchors[].domain'",
      );
    }
  }

  const comment =
    Array.isArray(obj.$comment) && obj.$comment.every((c) => typeof c === "string")
      ? (obj.$comment as string[])
      : undefined;

  return {
    ...(comment ? { $comment: comment } : {}),
    domains: derivedDomains,
    anchors: entries,
  };
}

const DEFAULT_FLEET_PATH = fileURLToPath(
  new URL("../../../contracts/anchors.json", import.meta.url),
);

/** Load and validate `contracts/anchors.json` (or a custom path). */
export function loadFleet(path: string = DEFAULT_FLEET_PATH): AnchorFleet {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return parseFleet(raw);
}
