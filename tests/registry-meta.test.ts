// Reading the metadata back.
//
// The shape that matters here is absence: a domain attested before metadata
// existed has no `Meta` entry, the contract says `NotFound`, and the reader has
// to turn that one code into "no metadata" without turning every other reversion
// into the same thing. An outage decoded as an empty list would tell an operator
// that an anchor receives nothing when nobody has asked it anything.

import { describe, expect, it, vi } from "vitest";
import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  AnchorRegistry,
  RegistryContractError,
  contractErrorCode,
  type AnchorMetadata,
} from "@corridor/registry";

type RegistryRead = (method: string, ...args: xdr.ScVal[]) => Promise<unknown>;

const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

function newRegistry(): AnchorRegistry {
  return new AnchorRegistry({
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: CONTRACT,
    networkPassphrase: "Test SDF Network ; September 2015",
  });
}

function stubRead(registry: AnchorRegistry) {
  return vi.spyOn(registry as unknown as { read: RegistryRead }, "read");
}

const RAW_RECORD = {
  domain: "a.example",
  seps: 0b1 | 0b100000,
  toml_hash: new Uint8Array(32),
  probes_run: 0b10000,
  probes_passed: 0b10000,
  attested_ledger: 100,
  attester: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
};

const RAW_META = {
  domain: "a.example",
  receive_assets: ["NGN", "KES"],
  country: "NG",
  attested_ledger: 140,
  attester: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
};

/** The error a simulated read throws when the contract reverts with `code`. */
function reverted(method: string, code: number): Error {
  return new Error(`${method} failed: HostError: Error(Contract, #${code})`);
}

describe("AnchorRegistry.getMeta", () => {
  it("decodes the contract's own key names and ledger stamp", async () => {
    const registry = newRegistry();
    const read = stubRead(registry).mockResolvedValue(RAW_META);

    const meta = await registry.getMeta("a.example");

    expect(meta).toEqual<AnchorMetadata>({
      domain: "a.example",
      receiveAssets: ["NGN", "KES"],
      country: "NG",
      attestedLedger: 140,
      attester: RAW_META.attester,
    });
    expect(read).toHaveBeenCalledWith("get_meta", expect.anything());
  });

  it("asks for the domain as a String, not a Symbol", async () => {
    const registry = newRegistry();
    const read = stubRead(registry).mockResolvedValue(RAW_META);

    await registry.getMeta("a.example");

    const arg = read.mock.calls[0][1];
    expect(arg.toXDR("base64")).toBe(
      nativeToScVal("a.example", { type: "string" }).toXDR("base64"),
    );
  });

  it("reads a null country as no country, not as one that is empty", async () => {
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue({ ...RAW_META, country: null });

    const meta = await registry.getMeta("a.example");

    expect(meta?.country).toBeUndefined();
    expect("country" in (meta as object)).toBe(false);
  });

  it("keeps an empty receive list as the finding that it is", async () => {
    const registry = newRegistry();
    stubRead(registry).mockResolvedValue({ ...RAW_META, receive_assets: [] });

    const meta = await registry.getMeta("a.example");

    expect(meta?.receiveAssets).toEqual([]);
  });

  it("returns null for the contract's NotFound and nothing else", async () => {
    const registry = newRegistry();
    stubRead(registry).mockRejectedValue(
      reverted("registry.get_meta", RegistryContractError.NotFound),
    );

    await expect(registry.getMeta("a.example")).resolves.toBeNull();
  });

  it("rethrows a reversion that is not NotFound", async () => {
    // Budget and initialisation failures are about the reader's environment, not
    // about the anchor, and reporting them as "no metadata" would hide them.
    const registry = newRegistry();
    stubRead(registry).mockRejectedValue(
      new Error("registry.get_meta failed: HostError: Error(Budget, ExceededLimit)"),
    );

    await expect(registry.getMeta("a.example")).rejects.toThrow("Budget");
  });

  it("rethrows a contract error it does not recognise", async () => {
    const registry = newRegistry();
    stubRead(registry).mockRejectedValue(reverted("registry.get_meta", 42));

    await expect(registry.getMeta("a.example")).rejects.toThrow("#42");
  });
});

describe("AnchorRegistry.getAnchor with metadata", () => {
  it("reads the record alone by default", async () => {
    const registry = newRegistry();
    const read = stubRead(registry).mockResolvedValue(RAW_RECORD);

    const anchor = await registry.getAnchor("a.example");

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("get_anchor", expect.anything());
    expect("receiveAssets" in anchor).toBe(false);
    expect("country" in anchor).toBe(false);
  });

  it("merges metadata into the record when asked, keeping the two ledgers apart", async () => {
    const registry = newRegistry();
    const read = stubRead(registry).mockImplementation((method) =>
      Promise.resolve(method === "get_meta" ? RAW_META : RAW_RECORD),
    );

    const anchor = await registry.getAnchor("a.example", { meta: true });

    expect(read.mock.calls.map(([method]) => method)).toEqual(["get_anchor", "get_meta"]);
    expect(anchor.attestedLedger).toBe(100);
    expect(anchor.receiveAssets).toEqual(["NGN", "KES"]);
    expect(anchor.country).toBe("NG");
  });

  it("leaves the record alone when there is no metadata for it", async () => {
    const registry = newRegistry();
    stubRead(registry).mockImplementation((method) =>
      method === "get_meta"
        ? Promise.reject(reverted("registry.get_meta", RegistryContractError.NotFound))
        : Promise.resolve(RAW_RECORD),
    );

    const anchor = await registry.getAnchor("a.example", { meta: true });

    expect(anchor).toEqual({
      domain: "a.example",
      seps: [1, 31],
      probesRun: ["sep31_info"],
      probesPassed: ["sep31_info"],
      tomlHash: "00".repeat(32),
      attestedLedger: 100,
      attester: RAW_RECORD.attester,
    });
  });

  it("records an empty list without inventing a country", async () => {
    const registry = newRegistry();
    stubRead(registry).mockImplementation((method) =>
      Promise.resolve(
        method === "get_meta"
          ? { ...RAW_META, receive_assets: [], country: null }
          : RAW_RECORD,
      ),
    );

    const anchor = await registry.getAnchor("a.example", { meta: true });

    expect(anchor.receiveAssets).toEqual([]);
    expect("country" in anchor).toBe(false);
  });
});

describe("AnchorRegistry.receivesAsset", () => {
  it("asks the contract rather than computing it locally", async () => {
    const registry = newRegistry();
    const read = stubRead(registry).mockResolvedValue(true);

    await expect(registry.receivesAsset("a.example", "NGN")).resolves.toBe(true);

    expect(read).toHaveBeenCalledWith("receives_asset", expect.anything(), expect.anything());
    const [, domain, code] = read.mock.calls[0];
    expect(scValToNative(domain)).toBe("a.example");
    expect(scValToNative(code)).toBe("NGN");
  });

  it("surfaces NotFound for a domain with no metadata", async () => {
    const registry = newRegistry();
    stubRead(registry).mockRejectedValue(
      reverted("registry.receives_asset", RegistryContractError.NotFound),
    );

    await expect(registry.receivesAsset("a.example", "NGN")).rejects.toThrow("#6");
  });
});

describe("contractErrorCode", () => {
  it("pulls the number out of a host error that names one", () => {
    expect(contractErrorCode(reverted("registry.get_meta", 6))).toBe(6);
    expect(contractErrorCode(new Error("HostError: Error(Contract, #10)"))).toBe(10);
    expect(contractErrorCode("HostError: Error(Contract, #7)")).toBe(7);
  });

  it("has no number for anything else", () => {
    expect(
      contractErrorCode(new Error("registry.get_meta returned no value")),
    ).toBeUndefined();
    expect(contractErrorCode("HostError: Error(Budget, ExceededLimit)")).toBeUndefined();
  });

  it("numbers the metadata errors the same way the contract does", () => {
    // The TS enum and `enum Error` in contracts/registry/src/lib.rs are the same
    // numbers only if somebody keeps them so; this is the cheapest pin available.
    expect(RegistryContractError.NotFound).toBe(6);
    expect(RegistryContractError.TooManyAssets).toBe(7);
    expect(RegistryContractError.InvalidAssetCode).toBe(8);
    expect(RegistryContractError.DuplicateAsset).toBe(9);
    expect(RegistryContractError.InvalidCountry).toBe(10);
  });
});
