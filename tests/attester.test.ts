// The attester's callers branch on WHY the contract refused an attestation — a
// cooldown hit is the system working, anything else fails the job. That
// decision must ride on the contract's numeric error code, never on the
// English wording of a message meant for operators.

import { describe, expect, it } from "vitest";
import { Account, Keypair, Networks } from "@stellar/stellar-sdk";
import { AnchorAttester, AttesterContractError, explain } from "@corridor/attester";
import type { ProbeResult } from "@corridor/probe";

/** The testnet attester contract id from README.md — any valid C… id will do. */
const CONTRACT_ID = "CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L";

const RESULT: ProbeResult = {
  domain: "a.example",
  seps: 0b1,
  probesRun: 0b11,
  probesPassed: 0b1,
  tomlHash: "00".repeat(32),
  outcomes: [],
};

/** An attester whose RPC server answers every simulation with `simError`. */
function attesterRejecting(simError: string): AnchorAttester {
  const signer = Keypair.random();
  const attester = new AnchorAttester({
    rpcUrl: "https://rpc.invalid",
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    signer,
  });
  const server = {
    getAccount: async () => new Account(signer.publicKey(), "1"),
    simulateTransaction: async () => ({
      id: "1",
      latestLedger: 1,
      error: simError,
      events: [],
    }),
  };
  Object.assign(attester, { server });
  return attester;
}

describe("explain", () => {
  it("maps contract error #3 to TooSoon", () => {
    const r = explain("HostError: Error(Contract, #3)");
    expect(r.code).toBe(AttesterContractError.TooSoon);
    expect(r.message).toContain("contract error #3");
  });

  it("flags that #4 can come from the registry (UnknownBit), not only the attester", () => {
    const r = explain("HostError: Error(Contract, #4)");
    expect(r.code).toBe(4);
    expect(r.message).toContain("invalid domain");
    expect(r.message).toContain("UnknownBit");
  });

  it("surfaces every known contract error code", () => {
    for (const code of [
      AttesterContractError.NotInitialised,
      AttesterContractError.NotAnAttester,
      AttesterContractError.TooSoon,
      AttesterContractError.InvalidDomain,
    ]) {
      expect(explain(`HostError: Error(Contract, #${code})`).code).toBe(code);
    }
  });

  it("still reports the number of a contract error it does not know", () => {
    const raw = "HostError: Error(Contract, #99)";
    expect(explain(raw)).toEqual({ code: 99, message: raw });
  });

  it("has no code for a host error that is not a contract error", () => {
    const raw = "HostError: Error(Budget, ExceededLimit)";
    expect(explain(raw)).toEqual({ message: raw });
  });
});

describe("AnchorAttester.attest — contract rejections", () => {
  it("carries a cooldown rejection as contractError TooSoon", async () => {
    const r = await attesterRejecting("HostError: Error(Contract, #3)").attest(RESULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.contractError).toBe(AttesterContractError.TooSoon);
    expect(r.error.message).toContain("a.example");
  });

  it("carries a non-enrolled signer as contractError NotAnAttester", async () => {
    const r = await attesterRejecting("HostError: Error(Contract, #2)").attest(RESULT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.contractError).toBe(AttesterContractError.NotAnAttester);
  });

  it("leaves contractError unset when the simulation failed for another reason", async () => {
    const r = await attesterRejecting("HostError: Error(Budget, ExceededLimit)").attest(
      RESULT,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.contractError).toBeUndefined();
  });
});

// The contract rejects a non-canonical domain with `Error(Contract, #4)`, but it
// only gets the chance after this client has loaded the account and simulated the
// transaction. The mirror check in `@corridor/probe` stops it there.
describe("AnchorAttester.attest — a domain that is not canonical", () => {
  /** An attester wired to an RPC that records, and refuses, every call. */
  function untouchedRpc(): { attester: AnchorAttester; calls: string[] } {
    const signer = Keypair.random();
    const attester = new AnchorAttester({
      rpcUrl: "https://rpc.invalid",
      contractId: CONTRACT_ID,
      networkPassphrase: Networks.TESTNET,
      signer,
    });
    const calls: string[] = [];
    const refuse = async (method: string) => {
      calls.push(method);
      throw new Error(`${method} must not be reached`);
    };
    Object.assign(attester, {
      server: {
        getAccount: () => refuse("getAccount"),
        simulateTransaction: () => refuse("simulateTransaction"),
      },
    });
    return { attester, calls };
  }

  it.each([
    "Cowrie.Exchange",
    "cowrie.exchange.",
    "https://cowrie.exchange/",
    "cowrie.exchange/.well-known",
    "cowrie.exchange:8000",
    "cowrie..exchange",
    "",
  ])("refuses %s before simulating", async (domain) => {
    const { attester, calls } = untouchedRpc();
    const r = await attester.attest({ ...RESULT, domain });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MANIFEST_INVALID");
    expect(r.error.message).toContain("canonical home domain");
    expect(calls).toEqual([]);
  });

  it("submits a canonical domain that the RPC stub above would have rejected", async () => {
    const { attester, calls } = untouchedRpc();
    const r = await attester.attest({ ...RESULT, domain: "cowrie.exchange" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Reached the RPC — so the refusal above is about the domain, not the stub.
    expect(calls).toEqual(["getAccount"]);
    expect(r.error.message).not.toContain("canonical");
  });
});
