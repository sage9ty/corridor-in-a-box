// Read the on-chain anchor registry from the dashboard.
//
// This file exists so the Corridors page can stop asserting things on its own
// authority. Previously the page rendered a hardcoded array and derived a green
// "runnable" badge from whether an endpoint STRING was non-empty — which is how
// a corridor pointing at a domain that does not resolve came to be displayed as
// healthy. Now the anchor facts come from a Soroban contract that only holds
// what an attester actually probed, so the page is structurally incapable of
// showing an unattested anchor as verified: if nobody checked, there is nothing
// to render.
//
// The web app is deliberately outside the pnpm workspace (see web/README.md) so
// it cannot import @corridor/registry; this is a small, self-contained mirror of
// the read path. Keep the two in step.

import { Contract, rpc, scValToNative, TransactionBuilder, Account, nativeToScVal } from "@stellar/stellar-sdk";
import deployments from "../../contracts/deployments.json";

/** SEP numbers in the registry's bit order. Mirrors SEP_NUMBERS in the contract. */
export const SEP_NUMBERS = [1, 6, 10, 12, 24, 31, 38] as const;
/** Probe names in the registry's bit order. Mirrors PROBE_NAMES in the contract. */
export const PROBE_NAMES = [
  "toml_fetch",
  "sep10_auth",
  "sep38_quote",
  "sep12_status",
  "sep31_info",
  "sep6_info",
  "sep6_auth",
] as const;

export type ProbeName = (typeof PROBE_NAMES)[number];

export interface AnchorAttestation {
  domain: string;
  /** What the anchor's stellar.toml ADVERTISES. */
  seps: number[];
  probesRun: ProbeName[];
  probesPassed: ProbeName[];
  tomlHash: string;
  attestedLedger: number;
  attester: string;
  /** Ledgers since the attestation. */
  staleness: number;
  /** Advertises SEP-31 AND passed the SEP-31 probe. Not the same as advertising it. */
  servesSep31: boolean;
}

const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** ~1 week of 5-second ledgers. Older than this and we say so on the page. */
export const STALE_AFTER_LEDGERS = 120_960;

type Network = keyof typeof deployments;

function config(network: string) {
  const cfg = (deployments as Record<string, unknown>)[network] as
    | { networkPassphrase: string; rpcUrl: string; registry: string | null }
    | undefined;
  return cfg?.registry ? cfg : undefined;
}

export const REGISTRY_NETWORK: string = process.env.STELLAR_NETWORK ?? "testnet";
export const REGISTRY_ID: string | undefined = config(REGISTRY_NETWORK)?.registry ?? undefined;

function decode<T>(mask: number, names: readonly T[]): T[] {
  return names.filter((_, i) => (mask & (1 << i)) !== 0);
}

interface RawRecord {
  domain: string;
  seps: number;
  toml_hash: Uint8Array;
  probes_run: number;
  probes_passed: number;
  attested_ledger: number;
  attester: string;
}

async function read<T>(method: string, args: ReturnType<typeof nativeToScVal>[] = []): Promise<T> {
  const cfg = config(REGISTRY_NETWORK);
  if (!cfg?.registry) throw new Error(`no registry deployed on ${REGISTRY_NETWORK}`);

  const server = new rpc.Server(cfg.rpcUrl);
  const contract = new Contract(cfg.registry);
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
    fee: "100",
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}: ${sim.error}`);
  if (!sim.result?.retval) throw new Error(`${method}: no value returned`);
  return scValToNative(sim.result.retval) as T;
}

const str = (s: string) => nativeToScVal(s, { type: "string" });

/**
 * Every attestation in the registry.
 *
 * Returns an empty array rather than throwing when the registry is unreachable:
 * a dashboard that cannot reach the chain should say it has no data, not crash.
 * The caller distinguishes "no attestations" from "could not read" via `ok`.
 *
 * `readAt` and `latestLedger` say when this snapshot was taken, so a page that
 * serves it from cache can say how old it is instead of presenting it as live.
 */
export async function fetchAttestations(): Promise<{
  ok: boolean;
  error?: string;
  anchors: AnchorAttestation[];
  /** ISO time the read started. Set even when the read failed. */
  readAt: string;
  /** The RPC's latest ledger at read time; absent when it could not be read. */
  latestLedger?: number;
}> {
  const readAt = new Date().toISOString();
  try {
    const cfg = config(REGISTRY_NETWORK);
    // Read before the anchors so the ledger is a lower bound on what they reflect.
    // Best-effort: the ledger only labels the snapshot, so failing to get it
    // must not hide attestations that read fine.
    const latestLedger = cfg
      ? await new rpc.Server(cfg.rpcUrl)
          .getLatestLedger()
          .then((l) => l.sequence)
          .catch(() => undefined)
      : undefined;
    const domains = await read<string[]>("domains");
    const anchors = await Promise.all(
      domains.map(async (domain) => {
        const raw = await read<RawRecord>("get_anchor", [str(domain)]);
        const [servesSep31, staleness] = await Promise.all([
          read<boolean>("serves_sep31", [str(domain)]),
          read<number>("staleness", [str(domain)]),
        ]);
        return {
          domain: raw.domain,
          seps: decode(raw.seps, SEP_NUMBERS) as number[],
          probesRun: decode(raw.probes_run, PROBE_NAMES),
          probesPassed: decode(raw.probes_passed, PROBE_NAMES),
          tomlHash: Buffer.from(raw.toml_hash).toString("hex"),
          attestedLedger: raw.attested_ledger,
          attester: raw.attester,
          staleness,
          servesSep31,
        } satisfies AnchorAttestation;
      }),
    );
    anchors.sort((a, b) => a.domain.localeCompare(b.domain));
    return { ok: true, anchors, readAt, latestLedger };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      anchors: [],
      readAt,
    };
  }
}

export type { Network };
