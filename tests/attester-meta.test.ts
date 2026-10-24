// What @corridor/attester puts on the wire for the metadata half.
//
// These tests pin the encoding rather than the plumbing: a Vec written as a
// single concatenated string, or a missing country encoded as the empty string,
// would both be accepted by some contract and read back as a fact that is not
// true. The absence cases matter as much as the presence ones.

import { describe, expect, it } from "vitest";
import {
  Account,
  Contract,
  Keypair,
  Networks,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { AnchorAttester, AttesterContractError } from "@corridor/attester";
import { probeBit, type ProbeResult } from "@corridor/probe";

const CONTRACT_ID = "CAHSKTAVHIES6MX2DUGNBA4VDB77WYNKEIZPOT7QX2RMJUL5RUIVKX2L";

const SEP31_RAN = probeBit("toml_fetch") | probeBit("sep31_info");

/** A probe result for an anchor that receives two assets and declares Nigeria. */
function result(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    domain: "a.example",
    seps: 0b1 | 0b100000,
    probesRun: SEP31_RAN,
    probesPassed: SEP31_RAN,
    tomlHash: "00".repeat(32),
    outcomes: [],
    receiveAssets: ["NGN", "KES"],
    country: "NG",
    ...overrides,
  };
}

/**
 * An attester whose every call is recorded and then rejected by the simulated
 * contract with `simError`.
 *
 * The rejection happens after the arguments are built, so the call log shows
 * exactly what would have been submitted. The contract object delegates to a
 * real one so the transaction still assembles.
 */
function recording(signer: Keypair, simError: string) {
  const calls: { method: string; args: xdr.ScVal[] }[] = [];
  const real = new Contract(CONTRACT_ID);
  const attester = new AnchorAttester({
    rpcUrl: "https://rpc.invalid",
    contractId: CONTRACT_ID,
    networkPassphrase: Networks.TESTNET,
    signer,
  });
  Object.assign(attester, {
    server: {
      getAccount: async () => new Account(signer.publicKey(), "1"),
      simulateTransaction: async () => ({
        id: "1",
        latestLedger: 1,
        error: simError,
        events: [],
      }),
    },
    contract: {
      call: (method: string, ...args: xdr.ScVal[]) => {
        calls.push({ method, args });
        return real.call(method, ...args);
      },
    },
  });
  return { attester, calls };
}

const TOO_SOON = "HostError: Error(Contract, #3)";

describe("AnchorAttester.attestMeta — argument encoding", () => {
  it("submits the domain, the asset list and the declared country", async () => {
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    await attester.attestMeta(result());

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("attest_meta");
    const [address, domain, assets, country] = calls[0].args;
    expect(scValToNative(address)).toBe(signer.publicKey());
    expect(scValToNative(domain)).toBe("a.example");
    expect(scValToNative(assets)).toEqual(["NGN", "KES"]);
    // Some("NG") is the string itself; Soroban reads Void as None.
    expect(country.toXDR("base64")).toBe(
      nativeToScVal("NG", { type: "string" }).toXDR("base64"),
    );
  });

  it("submits Void, not an empty string, when the anchor declared no country", async () => {
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    await attester.attestMeta(result({ country: undefined }));

    const country = calls[0].args[3];
    expect(country.toXDR("base64")).toBe(xdr.ScVal.scvVoid().toXDR("base64"));
    expect(scValToNative(country)).toBeNull();
  });

  it("submits an empty observed list as an empty Vec", async () => {
    // "We asked and it receives nothing" is a finding worth recording, and the
    // only way to say it is the empty list itself.
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    await attester.attestMeta(result({ receiveAssets: [] }));

    expect(scValToNative(calls[0].args[2])).toEqual([]);
    expect(calls[0].args.length).toBe(4);
  });

  it("keeps the list in the order the anchor served it", async () => {
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    await attester.attestMeta(result({ receiveAssets: ["USD", "NGN", "XOF"] }));

    expect(scValToNative(calls[0].args[2])).toEqual(["USD", "NGN", "XOF"]);
  });
});

describe("AnchorAttester.attestMeta — refusing to invent a finding", () => {
  it("refuses when the SEP-31 probe never ran, without calling the contract", async () => {
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    const r = await attester.attestMeta(
      result({
        probesRun: probeBit("toml_fetch"),
        probesPassed: probeBit("toml_fetch"),
        receiveAssets: undefined,
      }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MANIFEST_INVALID");
    expect(r.error.message).toContain("never ran");
    expect(calls).toHaveLength(0);
  });

  it("refuses when the probe ran and failed, because no answer was observed", async () => {
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    const r = await attester.attestMeta(
      result({ probesPassed: probeBit("toml_fetch"), receiveAssets: undefined }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("ran and failed");
    expect(calls).toHaveLength(0);
  });

  it("refuses when the list is missing even though the probe passed", async () => {
    // Belt and braces: a caller that hand-built a bitmap without a list has no
    // observation to submit either.
    const signer = Keypair.random();
    const { attester, calls } = recording(signer, TOO_SOON);

    await expect(
      attester.attestMeta(result({ receiveAssets: undefined })),
    ).resolves.toMatchObject({
      ok: false,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("AnchorAttester.attestMeta — contract rejections", () => {
  it("carries a bounds rejection as its numeric contract error", async () => {
    const signer = Keypair.random();
    const { attester } = recording(signer, "HostError: Error(Contract, #5)");

    const r = await attester.attestMeta(result());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.contractError).toBe(AttesterContractError.TooManyAssets);
    expect(r.error.message).toContain("too many receive assets");
  });

  it("names a cooldown on the metadata write as TooSoon", async () => {
    const signer = Keypair.random();
    const { attester } = recording(signer, TOO_SOON);

    const r = await attester.attestMeta(result());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.contractError).toBe(AttesterContractError.TooSoon);
  });

  it("leaves contractError unset for a rejection that is not a contract error", async () => {
    const signer = Keypair.random();
    const { attester } = recording(signer, "HostError: Error(Budget, ExceededLimit)");

    const r = await attester.attestMeta(result());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.contractError).toBeUndefined();
  });
});
