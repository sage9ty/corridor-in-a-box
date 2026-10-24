// How old is what the page is showing? Plain helpers with no SDK import, so the
// client-side freshness line can use them without pulling @stellar/stellar-sdk
// into the browser bundle.

/** Stellar's target close time. Real ledgers drift a little, hence "~" wherever it is used. */
export const SECONDS_PER_LEDGER = 5;

/** A ledger count as a rough human duration, e.g. 17_280 -> "~1 day". */
export function approxLedgerDuration(ledgers: number): string {
  return `~${formatDuration(ledgers * SECONDS_PER_LEDGER)}`;
}

/** Largest whole unit: "45 seconds", "3 minutes", "5 hours", "2 days". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const units: [string, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [name, size] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${s} second${s === 1 ? "" : "s"}`;
}

/** "2026-10-17 14:05 UTC". Fixed format and zone so server and client render the same text. */
export function formatUtc(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
