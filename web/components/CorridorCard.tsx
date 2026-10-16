import Link from "next/link";
import { ArrowRight, CircleCheck, CircleHelp, CircleSlash } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { liveness, type Corridor } from "@/lib/corridors";

// Green is reserved for corridors whose endpoints someone has actually checked.
// A lane with plausible-looking URLs that nobody has confirmed is amber, not
// green — the badge reports what we know, not what the YAML claims.
const BADGE = {
  proven: { variant: "success", Icon: CircleCheck, label: "proven" },
  verified: { variant: "success", Icon: CircleCheck, label: "verified" },
  unverified: { variant: "warning", Icon: CircleHelp, label: "unverified" },
  "not-runnable": { variant: "default", Icon: CircleSlash, label: "not runnable" },
} as const;

export function CorridorCard({ corridor }: { corridor: Corridor }) {
  const live = liveness(corridor);
  const badge = BADGE[live.state];

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-mono text-sm font-semibold">{corridor.id}</div>
          <div className="mt-1 flex items-center gap-1.5 text-sm text-secondary-text">
            {corridor.fx.path.map((hop, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <span className="font-medium text-primary-text">{hop}</span>
                {i < corridor.fx.path.length - 1 && <ArrowRight size={12} />}
              </span>
            ))}
          </div>
        </div>
        <Badge variant={badge.variant}>
          <badge.Icon size={12} /> {badge.label}
        </Badge>
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

      <Link
        href={`/payments?corridor=${corridor.id}`}
        className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
      >
        Run a payment <ArrowRight size={14} />
      </Link>
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
