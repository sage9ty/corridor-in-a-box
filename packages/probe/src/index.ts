// @corridor/probe — go and ask an anchor what it actually does.
//
// The registry stores two different kinds of claim and never conflates them:
//
//   seps           what the anchor's stellar.toml ADVERTISES
//   probesPassed   what actually WORKED when we called it
//
// Keeping them apart is the whole point. `testanchor.stellar.org` advertises
// SEP-31 and returns an empty receive list — a tool that reads the toml alone
// calls that lane runnable, which is exactly the mistake this project is
// correcting. So every probe here does real protocol work: SEP-10 signs a
// challenge and exchanges it for a JWT, SEP-38 asks for a firm quote and checks
// the expiry is in the future, SEP-31 confirms the receive list is non-empty.
//
// `fetchImpl` is injectable so the whole thing is testable without a network.

import { Keypair, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { tomlHash as tomlHashText } from "./toml-hash";
import { isSafeUrl } from "./url-safety";

export { tomlHash } from "./toml-hash";
export { isSafeUrl } from "./url-safety";

/** SEP numbers in registry bit order. Must match SEP_NUMBERS in contracts/registry. */
export const SEP_NUMBERS = [1, 6, 10, 12, 24, 31, 38] as const;
/** Probe names in registry bit order. Must match PROBE_NAMES in contracts/registry. */
export const PROBE_NAMES = [
  "toml_fetch",
  "sep10_auth",
  "sep38_quote",
  "sep12_status",
  "sep31_info",
] as const;

export type SepNumber = (typeof SEP_NUMBERS)[number];
export type ProbeName = (typeof PROBE_NAMES)[number];

export const sepBit = (sep: SepNumber): number => 1 << SEP_NUMBERS.indexOf(sep);
export const probeBit = (probe: ProbeName): number => 1 << PROBE_NAMES.indexOf(probe);

export function decodeSeps(mask: number): SepNumber[] {
  return SEP_NUMBERS.filter((_, i) => (mask & (1 << i)) !== 0);
}
export function decodeProbes(mask: number): ProbeName[] {
  return PROBE_NAMES.filter((_, i) => (mask & (1 << i)) !== 0);
}

export interface ProbeOutcome {
  readonly probe: ProbeName;
  readonly passed: boolean;
  /** Why it passed or failed, for a human reading the job log. */
  readonly detail: string;
}

export interface ProbeResult {
  readonly domain: string;
  /** Bitmap over SEP_NUMBERS — advertised in the toml. */
  readonly seps: number;
  /** Bitmap over PROBE_NAMES — attempted. */
  readonly probesRun: number;
  /** Bitmap over PROBE_NAMES — passed. Always a subset of probesRun. */
  readonly probesPassed: number;
  /** SHA-256 of the stellar.toml, hex. All zeroes if it could not be fetched. */
  readonly tomlHash: string;
  /** Per-probe detail, in the order probes were attempted. */
  readonly outcomes: readonly ProbeOutcome[];
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Keypair used for the SEP-10 handshake. A random throwaway by default —
   *  SEP-10 authenticates an account, and any account will do to prove the
   *  endpoint performs the handshake correctly. */
  keypair?: Keypair;
  now?: () => number;
}

const ZERO_HASH = "0".repeat(64);

/** Endpoint keys in a stellar.toml, and which SEP each one implies. */
const TOML_ENDPOINTS: ReadonlyArray<{ key: string; sep: SepNumber }> = [
  { key: "TRANSFER_SERVER", sep: 6 },
  { key: "WEB_AUTH_ENDPOINT", sep: 10 },
  { key: "KYC_SERVER", sep: 12 },
  { key: "TRANSFER_SERVER_SEP0024", sep: 24 },
  { key: "DIRECT_PAYMENT_SERVER", sep: 31 },
  { key: "ANCHOR_QUOTE_SERVER", sep: 38 },
];

/**
 * Read a top-level key from a stellar.toml.
 *
 * Deliberately not a full TOML parser: only bare `KEY = "value"` or
 * `KEY = 'value'` at the start of a line is accepted, which is how every
 * endpoint key is written — TOML allows either quote style for a basic
 * string, and real anchors use both (cowrie.exchange's live toml is entirely
 * single-quoted). Anything inside a `[[CURRENCIES]]` table or similar is
 * ignored rather than misattributed to the document root.
 */
export function tomlValue(toml: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = toml.match(
    new RegExp(`^[ \\t]*${escaped}[ \\t]*=[ \\t]*(?:"([^"]*)"|'([^']*)')`, "m"),
  );
  const value = (m?.[1] ?? m?.[2])?.trim();
  return value ? value : undefined;
}

export async function probeAnchor(
  domain: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const now = opts.now ?? (() => Date.now());
  const outcomes: ProbeOutcome[] = [];

  let seps = 0;
  let probesRun = 0;
  let probesPassed = 0;
  let tomlHash = ZERO_HASH;

  // Single choke point: every endpoint fetched past the initial SEP-1 request
  // is a URL the anchor's own stellar.toml supplied. Refuse anything that
  // isn't a public https:// host before it's dereferenced — see url-safety.ts.
  const get = (url: string, init?: RequestInit) => {
    if (!isSafeUrl(url)) {
      return Promise.reject(new Error(`refusing to fetch unsafe url: ${url}`));
    }
    return doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };

  const record = (probe: ProbeName, passed: boolean, detail: string) => {
    probesRun |= probeBit(probe);
    if (passed) probesPassed |= probeBit(probe);
    outcomes.push({ probe, passed, detail });
  };
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // --- SEP-1 -------------------------------------------------------------
  let toml: string;
  try {
    const res = await get(`https://${domain}/.well-known/stellar.toml`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toml = await res.text();
    tomlHash = tomlHashText(toml);
    seps |= sepBit(1);
    record("toml_fetch", true, `sha256 ${tomlHash.slice(0, 16)}…`);
  } catch (e) {
    record("toml_fetch", false, why(e));
    // No toml means nothing else can be discovered. Returning here keeps
    // probesRun honest: we did not attempt what we could not reach.
    return { domain, seps, probesRun, probesPassed, tomlHash, outcomes };
  }

  const endpoint = new Map<SepNumber, string>();
  for (const { key, sep } of TOML_ENDPOINTS) {
    const url = tomlValue(toml, key);
    if (url) {
      endpoint.set(sep, url);
      seps |= sepBit(sep);
    }
  }

  // --- SEP-10: a full handshake, not a reachability check ----------------
  let token: string | undefined;
  const webAuth = endpoint.get(10);
  if (webAuth) {
    try {
      const kp = opts.keypair ?? Keypair.random();
      const challengeRes = await get(
        `${webAuth}?account=${kp.publicKey()}&home_domain=${domain}`,
      );
      if (!challengeRes.ok) throw new Error(`challenge HTTP ${challengeRes.status}`);
      const ch = (await challengeRes.json()) as {
        transaction?: string;
        network_passphrase?: string;
      };
      if (!ch.transaction || !ch.network_passphrase) {
        throw new Error("challenge missing transaction/network_passphrase");
      }
      const tx = TransactionBuilder.fromXDR(
        ch.transaction,
        ch.network_passphrase,
      ) as Transaction;
      tx.sign(kp);
      const tokenRes = await get(webAuth, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: tx.toXDR() }),
      });
      if (!tokenRes.ok) throw new Error(`token HTTP ${tokenRes.status}`);
      const out = (await tokenRes.json()) as { token?: string };
      if (!out.token) throw new Error("no token returned");
      token = out.token;
      record("sep10_auth", true, "challenge signed, JWT issued");
    } catch (e) {
      record("sep10_auth", false, why(e));
    }
  }

  const authHeader: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

  // --- SEP-38: a FIRM quote that has not already expired -----------------
  const sep38 = endpoint.get(38);
  if (sep38) {
    try {
      const infoRes = await get(`${sep38}/info`);
      if (!infoRes.ok) throw new Error(`info HTTP ${infoRes.status}`);
      const info = (await infoRes.json()) as { assets?: { asset: string }[] };
      const sell = info.assets?.find((a) => a.asset.startsWith("stellar:"));
      const buy = info.assets?.find((a) => a.asset.startsWith("iso4217:"));
      if (!sell || !buy) throw new Error("no stellar→fiat pair advertised");

      const res = await get(`${sep38}/quote`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader },
        body: JSON.stringify({
          context: "sep31",
          sell_asset: sell.asset,
          buy_asset: buy.asset,
          sell_amount: "10",
        }),
      });
      if (!res.ok) throw new Error(`quote HTTP ${res.status}`);
      const q = (await res.json()) as { expires_at?: string };
      const expiry = q.expires_at ? Date.parse(q.expires_at) : NaN;
      if (!Number.isFinite(expiry)) throw new Error("quote has no parsable expires_at");
      // An already-expired firm quote is not a working quote server.
      if (expiry <= now()) throw new Error(`quote already expired (${q.expires_at})`);
      record("sep38_quote", true, `firm quote expires ${q.expires_at}`);
    } catch (e) {
      record("sep38_quote", false, why(e));
    }
  }

  // --- SEP-12: does the endpoint speak the protocol at all? --------------
  const kyc = endpoint.get(12);
  if (kyc && token) {
    try {
      const res = await get(`${kyc}/customer?type=sep31-receiver`, { headers: authHeader });
      // A 4xx is a valid SEP-12 answer ("no such customer"); a 5xx or a
      // connection failure is not. We are probing that it speaks the protocol,
      // not that any particular customer exists.
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      record("sep12_status", true, `HTTP ${res.status}`);
    } catch (e) {
      record("sep12_status", false, why(e));
    }
  }

  // --- SEP-31: does it receive anything? ---------------------------------
  const sep31 = endpoint.get(31);
  if (sep31) {
    try {
      const res = await get(`${sep31}/info`, { headers: authHeader });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { receive?: Record<string, unknown> };
      const assets = Object.keys(j.receive ?? {});
      if (assets.length === 0) {
        // The distinction that matters for an off-ramp registry: the endpoint
        // exists, the lane does not.
        throw new Error("receive list is EMPTY — advertises SEP-31 but accepts nothing");
      }
      record("sep31_info", true, `receives ${assets.join(", ")}`);
    } catch (e) {
      record("sep31_info", false, why(e));
    }
  }

  return { domain, seps, probesRun, probesPassed, tomlHash, outcomes };
}

export interface FormattedProbeResultJson {
  readonly domain: string;
  readonly tomlHash: string;
  readonly outcomes: readonly ProbeOutcome[];
  readonly seps: readonly SepNumber[];
  readonly probesPassed: readonly ProbeName[];
  readonly probesRun: readonly ProbeName[];
  readonly raw: {
    readonly seps: number;
    readonly probesRun: number;
    readonly probesPassed: number;
  };
}

/**
 * Format a ProbeResult into a clean JSON string with decoded SEP numbers and probe names.
 */
export function formatProbeResultJson(result: ProbeResult): string {
  const data: FormattedProbeResultJson = {
    ...result,
    seps: decodeSeps(result.seps),
    probesPassed: decodeProbes(result.probesPassed),
    probesRun: decodeProbes(result.probesRun),
    raw: {
      seps: result.seps,
      probesRun: result.probesRun,
      probesPassed: result.probesPassed,
    },
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Parse CLI arguments for probe:anchor, extracting domain and --json flag.
 */
export function parseProbeArgs(args: readonly string[]): { domain?: string; json: boolean } {
  let domain: string | undefined;
  let json = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
    } else if (!arg.startsWith("-") && !domain) {
      domain = arg;
    }
  }
  return { domain, json };
}
