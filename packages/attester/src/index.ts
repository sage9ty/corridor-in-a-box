// @corridor/attester — put a probe result on chain.
//
// The write half of the registry. Takes a ProbeResult produced by
// @corridor/probe, and submits it through the attester contract, which checks
// the signer is enrolled and applies the per-domain cooldown before relaying to
// the registry.
//
// There are two writes because there are two kinds of fact: `attest` submits the
// bitmaps and the toml hash, `attestMeta` submits the receive assets it observed
// and the country the anchor declared about itself. Each has its own cooldown, so
// a sweep can submit both for the same domain in one ledger.
//
// This is the ONLY place a signing key is needed. Reading the registry
// (@corridor/registry) requires nothing.

import {
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { isCanonicalDomain, probeBit, type ProbeResult } from "@corridor/probe";
import { err, fail, ok, type CorridorError, type Outcome } from "@corridor/types";

export interface AttesterOptions {
  rpcUrl: string;
  /** Attester CONTRACT id (C…) — not the registry. */
  contractId: string;
  networkPassphrase: string;
  /** An enrolled attester key. Must have been added via `add_attester`. */
  signer: Keypair;
  /** How long to wait for the transaction to leave pending. Default 60s. */
  confirmTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AttestationRef {
  readonly txHash: string;
  readonly ledger?: number;
}

/**
 * Errors the attester CONTRACT can return, by its numeric code. Mirrors
 * `contracts/attester/src/lib.rs` `enum Error` — keep the two in step.
 *
 * Branch on these (via `AttesterError.contractError`) rather than on the text
 * of an error message: the wording is for humans and may change.
 */
export enum AttesterContractError {
  NotInitialised = 1,
  NotAnAttester = 2,
  TooSoon = 3,
  InvalidDomain = 4,
  TooManyAssets = 5,
  InvalidAssetCode = 6,
  DuplicateAsset = 7,
  InvalidCountry = 8,
}

/**
 * Mapped back to something legible because a bare "HostError: Error(Contract,
 * #3)" tells an operator reading a job log nothing about what to do next.
 */
const CONTRACT_ERRORS: Record<AttesterContractError, string> = {
  [AttesterContractError.NotInitialised]: "attester contract is not initialised",
  [AttesterContractError.NotAnAttester]:
    "this key is not an enrolled attester — run add_attester first",
  [AttesterContractError.TooSoon]:
    "too soon: this domain was attested within the cooldown window",
  [AttesterContractError.InvalidDomain]: "invalid domain",
  [AttesterContractError.TooManyAssets]:
    "too many receive assets in one attestation — the contract bounds the list",
  [AttesterContractError.InvalidAssetCode]:
    "an asset code is empty or longer than the contract allows",
  [AttesterContractError.DuplicateAsset]: "the same asset code was written twice",
  [AttesterContractError.InvalidCountry]:
    "country must be an ISO-3166-1 alpha-2 code, two uppercase letters",
};

/**
 * A CorridorError from {@link AnchorAttester.attest}. When the contract itself
 * rejected the attestation, `contractError` carries its numeric error code —
 * compare it against {@link AttesterContractError}.
 */
export interface AttesterError extends CorridorError {
  readonly contractError?: AttesterContractError | number;
}

export class AnchorAttester {
  private readonly server: rpc.Server;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly signer: Keypair;
  private readonly confirmTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AttesterOptions) {
    this.server = new rpc.Server(opts.rpcUrl);
    this.contract = new Contract(opts.contractId);
    this.networkPassphrase = opts.networkPassphrase;
    this.signer = opts.signer;
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 60_000;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** The address attestations will be recorded under. */
  get address(): string {
    return this.signer.publicKey();
  }

  /**
   * Submit a probe result.
   *
   * The result is submitted verbatim — this class never adjusts, rounds up or
   * fills in a bitmap. If a probe did not run, it is not claimed; the contract
   * rejects `probes_passed` exceeding `probes_run` anyway, but the honesty has
   * to start here rather than rely on the contract to catch it.
   */
  async attest(result: ProbeResult): Promise<Outcome<AttestationRef, AttesterError>> {
    // The contract checks this too, and would revert. Checking it here is about
    // the cost: a submission that reverts still gets simulated, and a domain in
    // a non-canonical spelling would otherwise take a whole probe run plus a
    // simulation to end up rejected.
    const bad = nonCanonicalDomain(result.domain);
    if (bad) return bad;

    if (result.probesPassed & ~result.probesRun) {
      return fail(
        "MANIFEST_INVALID",
        `refusing to submit a result claiming probes passed that were never run ` +
          `(${result.domain}: run=${result.probesRun} passed=${result.probesPassed})`,
      );
    }

    return this.submit("attest", result.domain, [
      nativeToScVal(this.signer.publicKey(), { type: "address" }),
      nativeToScVal(result.domain, { type: "string" }),
      nativeToScVal(result.seps, { type: "u32" }),
      // toml_hash is BytesN<32> on chain; the probe carries it as hex.
      xdr.ScVal.scvBytes(Buffer.from(result.tomlHash, "hex")),
      nativeToScVal(result.probesRun, { type: "u32" }),
      nativeToScVal(result.probesPassed, { type: "u32" }),
    ]);
  }

  /**
   * Submit the metadata half of a probe result: the assets the SEP-31 probe
   * OBSERVED as receivable, and the country the anchor DECLARED about itself.
   *
   * Refuses locally when there is no observation to submit. An empty receive
   * list is a finding — "we asked and it accepts nothing" — so filling one in
   * for a domain whose probe never ran would invent that finding, which is the
   * exact error this registry exists to correct. Absence is expressed by not
   * calling at all; the reader reports it as no metadata.
   *
   * `attest_meta` has its own cooldown on chain, separate from `attest`, so a
   * sweep may submit both halves in one ledger without one tripping the other.
   */
  async attestMeta(result: ProbeResult): Promise<Outcome<AttestationRef, AttesterError>> {
    // `attest_meta` goes through the same on-chain domain gate as `attest`.
    const bad = nonCanonicalDomain(result.domain);
    if (bad) return bad;

    const ran = (result.probesRun & probeBit("sep31_info")) !== 0;
    if (!ran || result.receiveAssets === undefined) {
      return fail(
        "MANIFEST_INVALID",
        `${result.domain}: no observed receive list to submit — sep31_info ` +
          `${ran ? "ran and failed" : "never ran"}. Not sending an empty list for a ` +
          `probe that produced no answer.`,
      );
    }

    return this.submit("attest_meta", result.domain, [
      nativeToScVal(this.signer.publicKey(), { type: "address" }),
      nativeToScVal(result.domain, { type: "string" }),
      xdr.ScVal.scvVec(
        [...result.receiveAssets].map((code) => nativeToScVal(code, { type: "string" })),
      ),
      // Option<String>: the contract reads Void as None, anything else as Some.
      ...(result.country === undefined
        ? [xdr.ScVal.scvVoid()]
        : [nativeToScVal(result.country, { type: "string" })]),
    ]);
  }

  /**
   * Simulate, then sign, send and confirm one contract call.
   *
   * Both writes go through here so a contract revert is reported the same way
   * whichever half of the attestation failed — including its numeric error code,
   * which is what callers branch on.
   */
  private async submit(
    method: string,
    domain: string,
    args: Parameters<Contract["call"]>[1][],
  ): Promise<Outcome<AttestationRef, AttesterError>> {
    try {
      const source = await this.server.getAccount(this.signer.publicKey());
      const built = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(this.contract.call(method, ...args))
        .setTimeout(30)
        .build();

      // Simulate first: it computes the resource footprint the transaction needs
      // AND surfaces a contract revert before anything is paid for.
      const sim = await this.server.simulateTransaction(built);
      if (rpc.Api.isSimulationError(sim)) {
        const { code, message } = explain(sim.error);
        const failed = fail("MANIFEST_INVALID", `${domain}: ${message}`);
        return code === undefined ? failed : err({ ...failed.error, contractError: code });
      }

      const prepared = rpc.assembleTransaction(built, sim).build();
      prepared.sign(this.signer);

      const sent = await this.server.sendTransaction(prepared);
      if (sent.status === "ERROR") {
        return fail("SETTLEMENT_FAILED", `${domain}: submission rejected`, {
          retryable: true,
        });
      }
      return this.confirm(sent.hash, domain);
    } catch (cause) {
      return fail("ANCHOR_UNAVAILABLE", `${domain}: ${method} failed`, {
        retryable: true,
        cause,
      });
    }
  }

  /** Poll until the transaction leaves PENDING, or time out. */
  private async confirm(hash: string, domain: string): Promise<Outcome<AttestationRef>> {
    const deadline = this.now() + this.confirmTimeoutMs;
    for (;;) {
      const got = await this.server.getTransaction(hash);
      if (got.status === "SUCCESS") {
        return ok({ txHash: hash, ledger: got.ledger });
      }
      if (got.status === "FAILED") {
        return fail("SETTLEMENT_FAILED", `${domain}: transaction ${hash} failed on chain`);
      }
      if (this.now() >= deadline) {
        // NOT retryable-by-resubmission: the transaction may still land, and
        // sending a second one would attest twice and trip the cooldown.
        return fail(
          "SETTLEMENT_TIMEOUT",
          `${domain}: ${hash} still pending after ${this.confirmTimeoutMs}ms — ` +
            `check before resubmitting, it may yet succeed`,
        );
      }
      await this.sleep(1_000);
    }
  }
}

/**
 * The attester calls the registry, and a registry error surfaces through the attester
 * with the REGISTRY's number. The two contracts number their errors independently, so
 * #3 and #4 mean different things depending on which contract raised them. Without
 * this hint a registry rejection is reported as an attester error: when the deployed
 * registry predates the probe names in `@corridor/probe`, every domain that ran a
 * newer probe came back as "invalid domain" (registry `UnknownBit` is also #4).
 */
const REGISTRY_CODE_HINT: Record<number, string> = {
  3: "if the registry raised it: probes_passed set a bit probes_run did not (PassedExceedsRun)",
  4: "if the registry raised it: a SEP or probe bit the deployed registry does not know (UnknownBit); upgrade() the registry to the current PROBE_NAMES",
};

/** The local refusal shared by both submission paths, or undefined when the domain is fine. */
function nonCanonicalDomain(domain: string): Outcome<never, AttesterError> | undefined {
  if (isCanonicalDomain(domain)) return undefined;
  return fail(
    "MANIFEST_INVALID",
    `refusing to attest ${JSON.stringify(domain)}: not a canonical home domain. ` +
      `Lowercase letters, digits, dots and inner hyphens only — no scheme, port, path, ` +
      `uppercase, or leading/trailing dot or hyphen.`,
  );
}

/**
 * Map a raw host error onto the contract's own vocabulary where we can.
 *
 * `code` is the contract error number whenever the host error names one (even
 * one this client does not know yet); `message` is for humans only.
 */
export function explain(error: string): {
  code?: AttesterContractError | number;
  message: string;
} {
  const m = error.match(/Error\(Contract, #(\d+)\)/);
  if (!m) return { message: error };
  const code = Number(m[1]);
  const known = CONTRACT_ERRORS[code as AttesterContractError] as string | undefined;
  const hint = REGISTRY_CODE_HINT[code];
  return {
    code,
    message: known ? `${known} (contract error #${code})${hint ? ` — ${hint}` : ""}` : error,
  };
}
