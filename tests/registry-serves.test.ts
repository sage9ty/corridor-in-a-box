import { describe, expect, it, vi } from "vitest";
import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { AnchorRegistry, PROBE_NAMES, WEEK_OF_LEDGERS } from "@corridor/registry";
import { PROBE_NAMES as PROBE_PACKAGE_NAMES } from "@corridor/probe";

/** The slice of AnchorRegistry these tests stub: the private simulated read. */
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

describe("registry serves queries (#210)", () => {
  it("keeps PROBE_NAMES identical between the probe and registry packages", () => {
    expect(PROBE_NAMES).toEqual(PROBE_PACKAGE_NAMES);
  });

  it("reads serves_sep31 and serves_sep6 straight from the contract", async () => {
    const registry = newRegistry();
    const read = stubRead(registry);
    read.mockResolvedValue(true);

    await expect(registry.servesSep31("anchor.org")).resolves.toBe(true);
    expect(read).toHaveBeenLastCalledWith("serves_sep31", expect.anything());

    await expect(registry.servesSep6("anchor.org")).resolves.toBe(true);
    expect(read).toHaveBeenLastCalledWith("serves_sep6", expect.anything());
  });

  it("serves(protocol) dispatches to the matching contract query", async () => {
    const registry = newRegistry();
    const read = stubRead(registry);
    read.mockResolvedValue(true);

    await registry.serves("anchor.org", "sep31");
    expect(read).toHaveBeenLastCalledWith("serves_sep31", expect.anything());

    await registry.serves("anchor.org", "sep6");
    expect(read).toHaveBeenLastCalledWith("serves_sep6", expect.anything());
  });

  it("liveAnchors keeps anchors that serve the protocol and are within staleness", async () => {
    const registry = newRegistry();
    const read = stubRead(registry);
    read.mockImplementation((method, ...args) => {
      if (method === "domains") {
        return Promise.resolve(["fresh.org", "edge.org", "stale.org", "unsupported.org"]);
      }
      const domain = String(scValToNative(args[0]));
      if (method === "serves_sep6") return Promise.resolve(domain !== "unsupported.org");
      if (method === "staleness") {
        const ages: Record<string, number> = {
          "fresh.org": 0,
          "edge.org": WEEK_OF_LEDGERS,
          "stale.org": WEEK_OF_LEDGERS + 1,
          "unsupported.org": 0,
        };
        return Promise.resolve(ages[domain]);
      }
      return Promise.resolve(null);
    });

    await expect(registry.liveAnchors("sep6")).resolves.toEqual(["fresh.org", "edge.org"]);
  });

  it("liveSep31Anchors stays a wrapper over liveAnchors('sep31')", async () => {
    const registry = newRegistry();
    const read = stubRead(registry);
    read.mockImplementation((method) => {
      if (method === "domains") return Promise.resolve(["anchor.org"]);
      if (method === "serves_sep31") return Promise.resolve(true);
      if (method === "staleness") return Promise.resolve(0);
      return Promise.resolve(null);
    });

    await expect(registry.liveSep31Anchors()).resolves.toEqual(["anchor.org"]);
    expect(read).toHaveBeenCalledWith("serves_sep31", expect.anything());
  });
});
