// @corridor/registry — read the on-chain anchor conformance registry.
//
// The registry answers one question honestly: for a given anchor domain, which
// SEPs does it advertise, which conformance probes actually passed, and how long
// ago did anyone check? It holds facts, not opinions — no score, no ranking, no
// recommendation. Deciding which anchor to route through is the job of a
// RouteResolver, and that judgement is deliberately not on chain.
//
// READS ONLY. Writing goes through the attester contract and requires an
// enrolled key; a consumer of this package never needs one.

import {
  Contract,
  rpc,
  scValToNative,
  TransactionBuilder,
  Account,
} from "@stellar/stellar-sdk";

/** SEP numbers in the registry's bit order. Mirrors SEP_NUMBERS in the contract. */
export const SEP_NUMBERS = [1, 6, 10, 12, 24, 31, 38] as const;
/** Probe names in the registry's bit order. Mirrors PROBE_NAMES in the contract. */
export const PROBE_NAMES = [
  "toml_fetch",
  "sep10_auth",
  "sep38_quote",
  "sep12_status",
  "sep31_info",
] as const;

export type ProbeName = (typeof PROBE_NAMES)[number];

export interface AnchorAttestation {
  readonly domain: string;
  /** SEP numbers the anchor's stellar.toml advertises. */
  readonly seps: readonly number[];
  /** Probes that were attempted. */
  readonly probesRun: readonly ProbeName[];
  /** Probes that passed. Always a subset of `probesRun` — the contract enforces it. */
  readonly probesPassed: readonly ProbeName[];
  /** SHA-256 of the stellar.toml these facts were read from, hex. */
  readonly tomlHash: string;
  /** Ledger at which this was attested. */
  readonly attestedLedger: number;
  /** Address that produced the attestation. */
  readonly attester: string;
}

export interface RegistryOptions {
  /** Soroban RPC endpoint. */
  rpcUrl: string;
  /** Registry contract id (C…). */
  contractId: string;
  networkPassphrase: string;
  /**
   * Any funded account, used only to build the simulation envelope. Reads are
   * simulated and never submitted, so this account is never charged and needs no
   * signing key — but Soroban still requires a source account to simulate
   * against. Defaults to the null account, which works for pure reads.
   */
  simulationAccount?: string;
}

/** The all-zero account. Valid to simulate against; cannot sign anything. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function decodeBits<T>(mask: number, names: readonly T[]): T[] {
  return names.filter((_, i) => (mask & (1 << i)) !== 0);
}

/** Raw shape the contract returns, before it is turned into something readable. */
interface RawRecord {
  domain: string;
  seps: number;
  toml_hash: Uint8Array;
  probes_run: number;
  probes_passed: number;
  attested_ledger: number;
  attester: string;
}

export class AnchorRegistry {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly simulationAccount: string;

  constructor(opts: RegistryOptions) {
    this.server = new rpc.Server(opts.rpcUrl);
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase;
    this.simulationAccount = opts.simulationAccount ?? NULL_ACCOUNT;
  }

  /**
   * Simulate a read-only call and return the decoded result.
   *
   * Reads go through `simulateTransaction` rather than submission: nothing is
   * written, no fee is paid, and no key is needed. A simulation that comes back
   * with an error means the contract reverted — most often `NotFound` — so it is
   * surfaced rather than silently turned into a null.
   */
  private async read<T>(
    method: string,
    ...args: Parameters<Contract["call"]>[1][]
  ): Promise<T> {
    const source = new Account(this.simulationAccount, "0");
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`registry.${method} failed: ${sim.error}`);
    }
    if (!sim.result?.retval) {
      throw new Error(`registry.${method} returned no value`);
    }
    return scValToNative(sim.result.retval) as T;
  }

  /** Every domain with an attestation. */
  async domains(): Promise<string[]> {
    return this.read<string[]>("domains");
  }

  /** Full attestation for a domain. Throws if the domain has never been attested. */
  async getAnchor(domain: string): Promise<AnchorAttestation> {
    const raw = await this.read<RawRecord>("get_anchor", nativeToScValString(domain));
    return {
      domain: raw.domain,
      seps: decodeBits(raw.seps, SEP_NUMBERS),
      probesRun: decodeBits(raw.probes_run, PROBE_NAMES),
      probesPassed: decodeBits(raw.probes_passed, PROBE_NAMES),
      tomlHash: Buffer.from(raw.toml_hash).toString("hex"),
      attestedLedger: raw.attested_ledger,
      attester: raw.attester,
    };
  }

  /** SHA-256 of the stellar.toml the latest attestation was made from. */
  async tomlHash(domain: string): Promise<string> {
    const anchor = await this.getAnchor(domain);
    if (!anchor || typeof anchor.tomlHash !== "string") {
      throw new Error(`registry.get_anchor returned no TOML hash for ${domain}`);
    }
    return anchor.tomlHash;
  }

  /**
   * Whether the anchor both ADVERTISES SEP-31 and PASSED the SEP-31 probe.
   *
   * These are not the same thing, and the difference is the entire point of the
   * registry. `testanchor.stellar.org` advertises SEP-31 in its stellar.toml and
   * returns an empty receive list — it claims a capability it does not have.
   * Anything that reads the toml alone would call that lane runnable.
   */
  async servesSep31(domain: string): Promise<boolean> {
    return this.read<boolean>("serves_sep31", nativeToScValString(domain));
  }

  /** How many ledgers old the attestation is. */
  async staleness(domain: string): Promise<number> {
    return this.read<number>("staleness", nativeToScValString(domain));
  }

  /**
   * Domains that are attested as genuinely serving SEP-31 receive-side AND whose
   * attestation is fresher than `maxStalenessLedgers` (default ~1 week at 5s
   * ledgers). The query an operator looking for an off-ramp actually has.
   *
   * Freshness is not optional here: an attestation from six months ago is not
   * evidence about today, and letting callers forget to check would rebuild the
   * problem this registry exists to solve.
   */
  async liveSep31Anchors(maxStalenessLedgers = 120_960): Promise<string[]> {
    const all = await this.domains();
    const out: string[] = [];
    for (const domain of all) {
      const [serves, age] = await Promise.all([
        this.servesSep31(domain),
        this.staleness(domain),
      ]);
      if (serves && age <= maxStalenessLedgers) out.push(domain);
    }
    return out;
  }
}

// The SDK's nativeToScVal infers `String` for JS strings only with an explicit
// type hint; without it a domain would be encoded as a Symbol and the contract
// would reject the call.
import { nativeToScVal, type xdr } from "@stellar/stellar-sdk";
function nativeToScValString(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: "string" });
}
