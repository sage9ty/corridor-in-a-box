import { readFileSync } from "node:fs";
import {
  type ProbeResult,
  type ProbeOutcome,
  type SepNumber,
  type ProbeName,
  sepBit,
  probeBit,
  SEP_NUMBERS,
  PROBE_NAMES,
} from "./index";

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;
/** ISO-3166-1 alpha-2, as the registry stores it: two uppercase letters. */
const ALPHA2_REGEX = /^[A-Z]{2}$/;

function isUint32(val: unknown): val is number {
  return typeof val === "number" && Number.isInteger(val) && val >= 0 && val <= 0xffffffff;
}

export function parseProbeResults(input: unknown): ProbeResult[] {
  let data = input;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      throw new Error(
        `Malformed JSON in probe results: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  if (!data || typeof data !== "object") {
    throw new Error("Probe results must be a non-null object or array");
  }

  const items = Array.isArray(data) ? data : [data];
  if (items.length === 0) {
    return [];
  }

  return items.map((rawItem, idx) => {
    if (!rawItem || typeof rawItem !== "object") {
      throw new Error(`Probe result at index ${idx} must be an object`);
    }
    const item = rawItem as Record<string, unknown>;

    if (typeof item.domain !== "string" || item.domain.trim().length === 0) {
      throw new Error(`Probe result at index ${idx} is missing a valid domain`);
    }
    const domain = item.domain.trim();

    if (typeof item.tomlHash !== "string" || !HEX_64_REGEX.test(item.tomlHash)) {
      throw new Error(
        `Probe result for ${domain} has an invalid tomlHash (expected 64 hex characters)`,
      );
    }
    const tomlHash = item.tomlHash.toLowerCase();

    let seps: number | undefined;
    let probesRun: number | undefined;
    let probesPassed: number | undefined;

    // 1. Check raw object (from FormattedProbeResultJson)
    if (item.raw && typeof item.raw === "object") {
      const raw = item.raw as Record<string, unknown>;
      if (isUint32(raw.seps) && isUint32(raw.probesRun) && isUint32(raw.probesPassed)) {
        seps = raw.seps;
        probesRun = raw.probesRun;
        probesPassed = raw.probesPassed;
      }
    }

    // 2. Direct numeric bitmap fields
    if (
      seps === undefined &&
      isUint32(item.seps) &&
      isUint32(item.probesRun) &&
      isUint32(item.probesPassed)
    ) {
      seps = item.seps;
      probesRun = item.probesRun;
      probesPassed = item.probesPassed;
    }

    // 3. String/array representation
    if (
      seps === undefined &&
      Array.isArray(item.seps) &&
      Array.isArray(item.probesRun) &&
      Array.isArray(item.probesPassed)
    ) {
      seps = 0;
      for (const s of item.seps) {
        if (!SEP_NUMBERS.includes(s as SepNumber)) {
          throw new Error(`Probe result for ${domain} contains unknown SEP: ${s}`);
        }
        seps |= sepBit(s as SepNumber);
      }
      probesRun = 0;
      for (const p of item.probesRun) {
        if (!PROBE_NAMES.includes(p as ProbeName)) {
          throw new Error(`Probe result for ${domain} contains unknown probe name: ${p}`);
        }
        probesRun |= probeBit(p as ProbeName);
      }
      probesPassed = 0;
      for (const p of item.probesPassed) {
        if (!PROBE_NAMES.includes(p as ProbeName)) {
          throw new Error(`Probe result for ${domain} contains unknown probe name: ${p}`);
        }
        probesPassed |= probeBit(p as ProbeName);
      }
    }

    if (seps === undefined || probesRun === undefined || probesPassed === undefined) {
      throw new Error(
        `Probe result for ${domain} is missing valid bitmap fields (seps, probesRun, probesPassed)`,
      );
    }

    // Dishonesty check matching AnchorAttester.attest
    if ((probesPassed & ~probesRun) !== 0) {
      throw new Error(
        `refusing to submit a result claiming probes passed that were never run ` +
          `(${domain}: run=${probesRun} passed=${probesPassed})`,
      );
    }

    let outcomes: readonly ProbeOutcome[] = [];
    if (Array.isArray(item.outcomes)) {
      outcomes = item.outcomes.map((o, oIdx) => {
        if (!o || typeof o !== "object") {
          throw new Error(`Probe result for ${domain} outcome at index ${oIdx} is invalid`);
        }
        const outcome = o as Record<string, unknown>;
        if (
          typeof outcome.probe !== "string" ||
          typeof outcome.passed !== "boolean" ||
          typeof outcome.detail !== "string"
        ) {
          throw new Error(
            `Probe result for ${domain} outcome at index ${oIdx} has invalid fields`,
          );
        }
        return {
          probe: outcome.probe as ProbeName,
          passed: outcome.passed,
          detail: outcome.detail,
        };
      });
    }

    // Metadata is absent in a result stored before the registry had metadata,
    // so neither key is required. When it is present it must already be shaped
    // the way the contract demands: this is where a hand-edited file stops being
    // a surprise later, and an empty receive list is a real finding worth
    // keeping rather than dropping.
    // `sep31ReceiveAssets` is the same list under the name #231 asked for; a file may
    // carry either (or both, as probeAnchor writes), and either gets the same checks.
    const rawAssets = item.receiveAssets ?? item.sep31ReceiveAssets;
    let receiveAssets: string[] | undefined;
    if (rawAssets !== undefined) {
      if (
        !Array.isArray(rawAssets) ||
        !rawAssets.every((a) => typeof a === "string" && a.length > 0)
      ) {
        throw new Error(
          `Probe result for ${domain} has an invalid receiveAssets list (expected an array of asset codes)`,
        );
      }
      receiveAssets = rawAssets as string[];
    }

    if (item.country !== undefined && !ALPHA2_REGEX.test(String(item.country))) {
      throw new Error(
        `Probe result for ${domain} has an invalid country (expected ISO-3166-1 alpha-2, e.g. NG)`,
      );
    }
    const country = typeof item.country === "string" ? item.country : undefined;

    return {
      domain,
      seps,
      probesRun,
      probesPassed,
      tomlHash,
      outcomes,
      ...(receiveAssets ? { receiveAssets, sep31ReceiveAssets: receiveAssets } : {}),
      ...(country ? { country } : {}),
    };
  });
}

export function loadProbeResultsFromFile(filePath: string): ProbeResult[] {
  const content = readFileSync(filePath, "utf8");
  return parseProbeResults(content);
}

export interface AttestArgs {
  readonly from?: string;
  readonly domains: readonly string[];
}

export function parseAttestArgs(args: readonly string[]): AttestArgs {
  let from: string | undefined;
  const domains: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--from" && i + 1 < args.length) {
      from = args[++i];
    } else if (arg.startsWith("--from=")) {
      from = arg.slice("--from=".length);
    } else if (!arg.startsWith("-")) {
      domains.push(arg);
    }
  }
  return { from, domains };
}
