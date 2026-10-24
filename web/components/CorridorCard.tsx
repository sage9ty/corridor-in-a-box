import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { LivenessBadge } from "@/components/LivenessBadge";
import { liveness, type Corridor } from "@/lib/corridors";

export function CorridorCard({ corridor }: { corridor: Corridor }) {
  const live = liveness(corridor);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-mono text-sm font-semibold">
            <Link
              href={`/corridors/${corridor.id}`}
              className="hover:text-blue-600 hover:underline dark:hover:text-blue-400"
            >
              {corridor.id}
            </Link>
          </h3>
          <div className="mt-1 flex items-center gap-1.5 text-sm text-secondary-text">
            {corridor.fx.path.map((hop, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <span className="font-medium text-primary-text">{hop}</span>
                {i < corridor.fx.path.length - 1 && (
                  <>
                    <ArrowRight size={12} />
                    <span className="sr-only">to</span>
                  </>
                )}
              </span>
            ))}
          </div>
        </div>
        <LivenessBadge state={live.state} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <Field label="Source" value={corridor.source.name} />
        <Field label="Destination" value={corridor.dest.name} />
        <Field label="Bridge" value={`${corridor.settlement.bridge_asset} · ${corridor.settlement.network}`} />
        <Field label="Risk" value={corridor.fx.who_holds_risk} />
      </dl>

      {corridor.status_note && (
        <p className="rounded-lg bg-bg-subtle px-3 py-2 text-xs text-secondary-text">
          {corridor.status_note}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4">
        <Link
          href={`/corridors/${corridor.id}`}
          // Every card says "Corridor details"; the label says which corridor, and still
          // starts with the visible words so voice control can say them.
          aria-label={`Corridor details for ${corridor.id}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Corridor details <ArrowRight size={14} aria-hidden="true" />
        </Link>
        <Link
          href={`/payments?corridor=${corridor.id}`}
          // Every card says "Run a payment"; the label says which corridor, and still
          // starts with the visible words so voice control can say them.
          aria-label={`Run a payment on ${corridor.id}`}
          className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          Run a payment <ArrowRight size={14} aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-secondary-text">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
