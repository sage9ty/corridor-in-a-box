// Pre-flight compatibility checks between corridor manifest and adapter capabilities (#188).
//
// Validates that the resolved adapter can actually honour the corridor manifest
// and that configured settlement strategies cover the adapter's settlement rails.
// Evaluated before quoting, complying, or opening a transaction, so mismatches
// fail closed (CAPABILITY_MISMATCH) before any state changes or money moves.

import type { AdapterCapabilities } from "@corridor/adapter-kit";
import type { Corridor } from "@corridor/manifest";
import { fail, ok, type Outcome } from "@corridor/types";
import type { SettlementStrategy } from "./ports";

/**
 * Validate that an adapter's advertised capabilities match the requirements
 * declared in a corridor manifest and the engine's configured settlement strategies.
 */
export function checkCompatibility(
  corridor: Corridor,
  caps: AdapterCapabilities,
  strategies: readonly SettlementStrategy[],
): Outcome<void> {
  // 1. Quote source vs caps.quotes
  if (corridor.fx.quote_source === "sep38") {
    const hasSep38 = caps.quotes.some((q) => q === "sep38_firm" || q === "sep38_indicative");
    if (!hasSep38) {
      return fail(
        "CAPABILITY_MISMATCH",
        `corridor "${corridor.id}" requires fx.quote_source "sep38", but adapter only supports quotes: [${caps.quotes.join(", ")}]`,
        { retryable: false },
      );
    }
  }

  // 2. Explicit compliance.method vs caps.kyc (#193). Only an explicit method
  // is checked: when the manifest is silent the adapter decides. A manifest
  // that says "none" must never switch off KYC an adapter enforces, and one
  // that says "sep12" must not run against an adapter that does no KYC.
  const method = corridor.compliance.method;
  if (method !== undefined && method !== caps.kyc) {
    return fail(
      "CAPABILITY_MISMATCH",
      `corridor "${corridor.id}" declares compliance.method "${method}", but adapter performs kyc "${caps.kyc}"`,
      { retryable: false },
    );
  }

  // 3. Settlement strategy coverage vs caps.settlement
  if (caps.settlement.length === 0) {
    return fail(
      "CAPABILITY_MISMATCH",
      `adapter advertises no settlement capabilities for corridor "${corridor.id}"`,
      { retryable: false },
    );
  }

  for (const kind of caps.settlement) {
    const covered = strategies.some((s) => s.kind === kind);
    if (!covered) {
      return fail(
        "CAPABILITY_MISMATCH",
        `adapter requires settlement kind "${kind}", but no matching SettlementStrategy is configured (configured: [${strategies.map((s) => s.kind).join(", ")}])`,
        { retryable: false },
      );
    }
  }

  return ok(undefined);
}
