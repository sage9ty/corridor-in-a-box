import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import { AnchorRegistry, decodeAttestationEvent } from "@corridor/registry";

/** The slice of the Soroban RPC client these tests stub. */
type RegistryServer = { getEvents: (...args: unknown[]) => Promise<unknown> };

interface FixtureData {
  latestLedger: number;
  oldestLedger: number;
  latestLedgerCloseTime: string;
  oldestLedgerCloseTime: string;
  cursor: string;
  events: Array<{
    id: string;
    type: string;
    ledger: number;
    ledgerClosedAt: string;
    contractId: string;
    txHash: string;
    topic: string[];
    value: string;
  }>;
}

const fixtureUrl = new URL("./fixtures/registry-history-events.json", import.meta.url);
const fixture: FixtureData = JSON.parse(readFileSync(fixtureUrl, "utf8"));

describe("registry history and event decoding (#249)", () => {
  it("decodes recorded RPC event fixture into AnchorAttestation records", () => {
    const rawEvents = fixture.events;
    expect(rawEvents.length).toBe(3);

    const decoded = rawEvents.map((e) => decodeAttestationEvent(e));

    // Event 0 is ledger 98000 for testanchor.stellar.org
    const ev0 = decoded[0];
    expect(ev0.domain).toBe("testanchor.stellar.org");
    expect(ev0.attestedLedger).toBe(98000);
    expect(ev0.tomlHash).toBe("22".repeat(32));
    expect(ev0.seps).toEqual([1, 10, 24, 31]);
    expect(ev0.probesRun).toEqual(["toml_fetch", "sep10_auth", "sep38_quote", "sep31_info"]);
    expect(ev0.probesPassed).toEqual([
      "toml_fetch",
      "sep10_auth",
      "sep38_quote",
      "sep31_info",
    ]);
    expect(ev0.attester).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

    // Event 1 is other.example
    const ev1 = decoded[1];
    expect(ev1.domain).toBe("other.example");
    expect(ev1.attestedLedger).toBe(97000);
    expect(ev1.tomlHash).toBe("33".repeat(32));
    expect(ev1.seps).toEqual([1]);
    expect(ev1.probesRun).toEqual(["toml_fetch"]);
    expect(ev1.probesPassed).toEqual(["toml_fetch"]);

    // Event 2 is ledger 95000 for testanchor.stellar.org
    const ev2 = decoded[2];
    expect(ev2.domain).toBe("testanchor.stellar.org");
    expect(ev2.attestedLedger).toBe(95000);
    expect(ev2.tomlHash).toBe("11".repeat(32));
    expect(ev2.seps).toEqual([1, 10, 31]);
    expect(ev2.probesRun).toEqual(["toml_fetch", "sep10_auth", "sep31_info"]);
    expect(ev2.probesPassed).toEqual(["toml_fetch", "sep10_auth"]);
  });

  it("AnchorRegistry.history filters by domain, sorts by ledger ascending, and reports covered range", async () => {
    const registry = new AnchorRegistry({
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    // Mock server.getEvents to return fixture data
    const getEvents = vi
      .spyOn((registry as unknown as { server: RegistryServer }).server, "getEvents")
      .mockResolvedValue({
        latestLedger: fixture.latestLedger,
        oldestLedger: fixture.oldestLedger,
        latestLedgerCloseTime: fixture.latestLedgerCloseTime,
        oldestLedgerCloseTime: fixture.oldestLedgerCloseTime,
        cursor: fixture.cursor,
        events: fixture.events,
      });

    const history = await registry.history("testanchor.stellar.org", {
      startLedger: 91000,
    });

    // The contract publishes topics (Symbol("attested"), domain), so the RPC filter must be
    // a single two-segment topic filter in that order or a live registry returns nothing.
    expect(getEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          expect.objectContaining({
            topics: [
              [
                nativeToScVal("attested", { type: "symbol" }).toXDR("base64"),
                nativeToScVal("testanchor.stellar.org", { type: "string" }).toXDR("base64"),
              ],
            ],
          }),
        ],
      }),
    );

    expect(history.domain).toBe("testanchor.stellar.org");
    expect(history.earliestLedgerCovered).toBe(91000);
    expect(history.latestLedger).toBe(100500);
    expect(history.oldestLedger).toBe(90000);

    // Only events for testanchor.stellar.org should be returned (ev1 was for other.example)
    expect(history.attestations.length).toBe(2);

    // Must be ordered by ledger ascending: 95000 then 98000
    expect(history.attestations[0].attestedLedger).toBe(95000);
    expect(history.attestations[1].attestedLedger).toBe(98000);
  });

  it("clamps earliestLedgerCovered to oldestLedger when startLedger is older than retention", async () => {
    const registry = new AnchorRegistry({
      rpcUrl: "https://soroban-testnet.stellar.org",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      networkPassphrase: "Test SDF Network ; September 2015",
    });

    vi.spyOn(
      (registry as unknown as { server: RegistryServer }).server,
      "getEvents",
    ).mockResolvedValue({
      latestLedger: fixture.latestLedger,
      oldestLedger: fixture.oldestLedger, // 90000
      latestLedgerCloseTime: fixture.latestLedgerCloseTime,
      oldestLedgerCloseTime: fixture.oldestLedgerCloseTime,
      cursor: fixture.cursor,
      events: [],
    });

    const history = await registry.history("testanchor.stellar.org", {
      startLedger: 80000, // older than 90000
    });

    expect(history.earliestLedgerCovered).toBe(90000);
    expect(history.latestLedger).toBe(100500);
    expect(history.attestations).toEqual([]);
  });
});
