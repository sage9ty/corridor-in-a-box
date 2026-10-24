import { describe, expect, it } from "vitest";
import {
  findStale,
  MAX_STALENESS_LEDGERS,
  WEEK_OF_LEDGERS,
  type StalenessRecord,
} from "@corridor/registry";

describe("registry staleness check (#237)", () => {
  it("exports expected threshold constants", () => {
    expect(MAX_STALENESS_LEDGERS).toBe(34_560); // 2 days at 5s
    expect(WEEK_OF_LEDGERS).toBe(120_960); // 7 days at 5s
    expect(MAX_STALENESS_LEDGERS).toBeLessThan(WEEK_OF_LEDGERS);
  });

  it("considers records with age <= threshold as fresh (returns empty)", () => {
    const records: StalenessRecord[] = [
      { domain: "fresh1.org", ledgersOld: 0 },
      { domain: "fresh2.org", ledgersOld: 100 },
      { domain: "fresh3.org", ledgersOld: MAX_STALENESS_LEDGERS },
    ];
    const stale = findStale(records, MAX_STALENESS_LEDGERS);
    expect(stale).toEqual([]);
  });

  it("identifies stale records exceeding the threshold", () => {
    const threshold = 1000;
    const records: StalenessRecord[] = [
      { domain: "fresh.org", ledgersOld: 999 },
      { domain: "boundary.org", ledgersOld: 1000 },
      { domain: "stale1.org", ledgersOld: 1001 },
      { domain: "stale2.org", ledgersOld: 50_000 },
    ];
    const stale = findStale(records, threshold);
    expect(stale).toHaveLength(2);
    expect(stale[0]).toEqual({
      domain: "stale1.org",
      reason: "stale",
      ledgersOld: 1001,
      threshold: 1000,
    });
    expect(stale[1]).toEqual({
      domain: "stale2.org",
      reason: "stale",
      ledgersOld: 50_000,
      threshold: 1000,
    });
  });

  it("identifies never-attested records (null, undefined, or neverAttested flag)", () => {
    const records: StalenessRecord[] = [
      { domain: "null-age.org", ledgersOld: null },
      { domain: "undefined-age.org", ledgersOld: undefined },
      { domain: "flagged.org", neverAttested: true },
    ];
    const stale = findStale(records);
    expect(stale).toHaveLength(3);
    for (const item of stale) {
      expect(item.reason).toBe("never-attested");
      expect(item.ledgersOld).toBeNull();
      expect(item.threshold).toBe(MAX_STALENESS_LEDGERS);
    }
    expect(stale.map((s) => s.domain)).toEqual([
      "null-age.org",
      "undefined-age.org",
      "flagged.org",
    ]);
  });

  it("filters a mixed set of fresh, stale, and never-attested records", () => {
    const records: StalenessRecord[] = [
      { domain: "fresh.org", ledgersOld: 500 },
      { domain: "never.org", ledgersOld: null, neverAttested: true },
      { domain: "stale.org", ledgersOld: 40_000 },
    ];
    const stale = findStale(records, MAX_STALENESS_LEDGERS);
    expect(stale).toHaveLength(2);
    expect(stale[0]).toEqual({
      domain: "never.org",
      reason: "never-attested",
      ledgersOld: null,
      threshold: MAX_STALENESS_LEDGERS,
    });
    expect(stale[1]).toEqual({
      domain: "stale.org",
      reason: "stale",
      ledgersOld: 40_000,
      threshold: MAX_STALENESS_LEDGERS,
    });
  });

  it("supports record with staleness property alias", () => {
    const records: StalenessRecord[] = [
      { domain: "fresh.org", staleness: 200 },
      { domain: "stale.org", staleness: 40_000 },
    ];
    const stale = findStale(records, 1000);
    expect(stale).toHaveLength(1);
    expect(stale[0].domain).toBe("stale.org");
    expect(stale[0].reason).toBe("stale");
    expect(stale[0].ledgersOld).toBe(40_000);
  });
});
