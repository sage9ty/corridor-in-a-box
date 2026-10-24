import { CircleCheck, CircleSlash, CircleHelp, Clock } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  PROBE_NAMES,
  STALE_AFTER_LEDGERS,
  type AnchorAttestation,
} from "@/lib/registry";
import { approxLedgerDuration } from "@/lib/freshness";

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
          <h3 className="truncate font-mono text-sm font-semibold">{anchor.domain}</h3>
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
          // Each probe is a term and its result, so a screen reader pairs them.
          // The result is spoken as text; the icon beside it is decoration, and
          // "not probed" is dimmed with a lighter text colour rather than with
          // opacity, which would take it under the contrast minimum.
          return (
            <div key={probe} className="flex items-center gap-2">
              <dt className={`font-mono ${ran ? "" : "text-secondary-text"}`}>{probe}</dt>
              <dd className="flex items-center gap-2 text-secondary-text">
                {!ran ? (
                  <CircleHelp size={12} className="shrink-0" />
                ) : passed ? (
                  <CircleCheck size={12} className="shrink-0 text-green-600" />
                ) : (
                  <CircleSlash size={12} className="shrink-0 text-red-600" />
                )}
                {!ran ? "not probed" : passed ? "passed" : "failed"}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="flex flex-col gap-1 border-t border-border pt-3 text-xs text-secondary-text">
        <div>
          attested at ledger <span className="font-mono">{anchor.attestedLedger}</span> ·{" "}
          {anchor.staleness.toLocaleString("en-US")} ledgers ({approxLedgerDuration(anchor.staleness)})
          ago
          {stale && <span className="font-medium text-yellow-700 dark:text-yellow-500"> · stale</span>}
        </div>
        <div className="truncate">
          toml sha256 <span className="font-mono">{anchor.tomlHash.slice(0, 24)}…</span>
        </div>
      </div>
    </Card>
  );
}
