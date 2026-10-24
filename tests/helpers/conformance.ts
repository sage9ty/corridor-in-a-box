import { expect } from "vitest";
import type { ConformanceReport } from "@corridor/adapter-kit";

export function expectConformance(report: ConformanceReport): void {
  for (const r of report.results) {
    expect(r.passed, `Conformance probe "${r.name}" failed: ${r.detail}`).toBe(true);
  }
  expect(report.passed).toBe(true);
}
