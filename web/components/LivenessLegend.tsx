import { Badge } from "@/components/ui/Badge";
import { BADGE } from "@/components/LivenessBadge";
import type { LivenessState } from "@/lib/corridors";

interface TierDetail {
  description: string;
  evidence: string;
}

const TIER_DETAILS: Record<LivenessState, TierDetail> = {
  proven: {
    description: "End-to-end payment completed through this lane within proof TTL.",
    evidence: "On-chain transaction hash and completed timestamp in manifest proof block.",
  },
  verified: {
    description: "Endpoints checked against anchor's published stellar.toml or running instance.",
    evidence: "endpoints_verified_at ISO date confirmed and recorded on destination anchor.",
  },
  unverified: {
    description: "Endpoints configured but unconfirmed against published anchor records.",
    evidence: "Uninspected endpoints; honest default before manual or automated verification.",
  },
  "not-runnable": {
    description: "Required endpoints are missing; corridor cannot execute settlement.",
    evidence: "Missing transfer server or required service endpoints in manifest.",
  },
};

const TIERS: LivenessState[] = ["proven", "verified", "unverified", "not-runnable"];

export function LivenessLegend() {
  return (
    <div className="rounded-xl border border-border bg-bg-subtle/50 p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-secondary-text">
        Liveness tiers & evidence requirements
      </h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TIERS.map((tier) => {
          const badge = BADGE[tier];
          const detail = TIER_DETAILS[tier];
          const Icon = badge.Icon;
          return (
            <div
              key={tier}
              className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-3 text-xs"
            >
              <div className="flex items-center gap-1.5 font-medium">
                <Badge variant={badge.variant}>
                  <Icon size={12} aria-hidden /> {badge.label}
                </Badge>
              </div>
              <p className="text-primary-text">{detail.description}</p>
              <div className="mt-auto pt-1 text-[11px] text-secondary-text">
                <span className="font-medium text-secondary-text">Evidence:</span> {detail.evidence}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
