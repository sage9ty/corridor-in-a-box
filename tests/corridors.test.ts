import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { liveness, loadCorridor } from "@corridor/manifest";

export const MAX_VERIFIED_AGE_DAYS = 45;
const CORRIDORS_DIR = fileURLToPath(new URL("../corridors/", import.meta.url));
const FILENAME_ID_EXCEPTIONS: Record<string, string> = {
  "reference.corridor.yaml": "reference-testnet",
};
const DAY_MS = 24 * 60 * 60 * 1000;

export function isVerifiedDateFresh(verifiedAt: string, today = new Date()): boolean {
  const verifiedAtMs = Date.parse(`${verifiedAt}T00:00:00.000Z`);
  if (
    !Number.isFinite(verifiedAtMs) ||
    new Date(verifiedAtMs).toISOString().slice(0, 10) !== verifiedAt ||
    !Number.isFinite(today.getTime())
  ) {
    return false;
  }

  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const ageDays = (todayMs - verifiedAtMs) / DAY_MS;
  return ageDays >= 0 && ageDays <= MAX_VERIFIED_AGE_DAYS;
}

describe("corridor manifests", () => {
  it("loads every YAML manifest with a unique ID and a matching filename", () => {
    const filenames = readdirSync(CORRIDORS_DIR).filter((filename) =>
      filename.endsWith(".yaml"),
    );
    expect(filenames.length).toBeGreaterThan(0);

    const ids = new Set<string>();
    for (const filename of filenames) {
      expect(filename, `${filename} must use the .corridor.yaml suffix`).toMatch(
        /\.corridor\.yaml$/,
      );

      const loaded = loadCorridor(join(CORRIDORS_DIR, filename));
      expect(
        loaded.ok,
        `${filename} must load: ${loaded.ok ? "" : loaded.error.message}`,
      ).toBe(true);
      if (!loaded.ok) continue;

      const expectedId =
        FILENAME_ID_EXCEPTIONS[filename] ?? filename.slice(0, -".corridor.yaml".length);
      expect(loaded.value.id, `${filename} must match its manifest ID`).toBe(expectedId);
      expect(ids.has(loaded.value.id), `duplicate corridor ID: ${loaded.value.id}`).toBe(
        false,
      );
      ids.add(loaded.value.id);

      const today = new Date();
      if (
        loaded.value.settlement.network === "public" &&
        liveness(loaded.value, today).state === "verified"
      ) {
        const verifiedAt = loaded.value.dest.endpoints.endpoints_verified_at;
        expect(
          verifiedAt !== undefined && isVerifiedDateFresh(verifiedAt, today),
          `${filename} has stale or missing endpoints_verified_at; re-probe the destination and refresh the date`,
        ).toBe(true);
      }
    }
  });

  it("accepts verified dates through the age limit and rejects stale or future dates", () => {
    const today = new Date("2026-10-18T12:00:00.000Z");

    expect(isVerifiedDateFresh("2026-09-03", today)).toBe(true);
    expect(isVerifiedDateFresh("2026-09-02", today)).toBe(false);
    expect(isVerifiedDateFresh("2026-10-19", today)).toBe(false);
    expect(isVerifiedDateFresh("2026-02-30", today)).toBe(false);
  });
});
