import { CircleCheck, CircleSlash, CircleHelp, Clock } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  PROBE_NAMES,
  STALE_AFTER_LEDGERS,
  type AnchorAttestation,
} from "@/lib/registry";

/**
 * One attested anchor.
 *
 * The card's job is to keep two facts visually distinct that a naive UI would
 * merge: what the anchor's stellar.toml ADVERTISES, and what actually WORKED
 * when someone called it. Showing only the first is what made a corridor
 * pointing at a non-existent domain look healthy.
 */
export function AnchorCard({ anchor }: { anchor: AnchorAttestation }) {
  const stale = anchor.staleness > STALE_AFTER_LEDGERS;
  // Green requires the capability to be advertised AND probed green AND fresh.
  const usable = anchor.servesSep31 && !stale;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold">{anchor.domain}</div>
          <div className="mt-1 text-sm text-secondary-text">
            {anchor.seps.length ? anchor.seps.map((n) => `SEP-${n}`).join(" · ") : "no SEP endpoints"}
          </div>
        </div>
        {usable ? (
          <Badge variant="success">
            <CircleCheck size={12} /> serves SEP-31
          </Badge>
        ) : anchor.servesSep31 ? (
          <Badge variant="warning">
            <Clock size={12} /> stale
          </Badge>
        ) : (
          <Badge variant="default">
            <CircleSlash size={12} /> no SEP-31
          </Badge>
        )}
      </div>

      {/* Per-probe results. A probe that was never run is rendered differently
          from one that ran and failed — "we didn't check" and "it doesn't work"
          are different claims and the page should not blur them. */}
      <dl className="flex flex-col gap-1 text-xs">
        {PROBE_NAMES.map((probe) => {
          const ran = anchor.probesRun.includes(probe);
          const passed = anchor.probesPassed.includes(probe);
          return (
            <div key={probe} className="flex items-center gap-2">
              {!ran ? (
                <CircleHelp size={12} className="shrink-0 text-secondary-text opacity-50" />
              ) : passed ? (
                <CircleCheck size={12} className="shrink-0 text-green-600" />
              ) : (
                <CircleSlash size={12} className="shrink-0 text-red-600" />
              )}
              <span className={`font-mono ${ran ? "" : "text-secondary-text opacity-50"}`}>
                {probe}
              </span>
              <span className="text-secondary-text">
                {!ran ? "not probed" : passed ? "passed" : "failed"}
              </span>
            </div>
          );
        })}
      </dl>

      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-secondary-text">
        <div>
          attested at ledger <span className="font-mono">{anchor.attestedLedger}</span> ·{" "}
          {anchor.staleness.toLocaleString()} ledgers ago
          {stale && <span className="font-medium text-yellow-700 dark:text-yellow-500"> · stale</span>}
        </div>
        <div className="truncate">
          toml sha256 <span className="font-mono">{anchor.tomlHash.slice(0, 24)}…</span>
        </div>
      </div>
    </Card>
  );
}
