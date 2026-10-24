import { CircleCheck, CircleHelp, CircleSlash } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import type { LivenessState } from "@/lib/corridors";

export interface BadgeConfig {
  variant: "default" | "success" | "warning" | "danger" | "info";
  Icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  label: string;
}

// Green is reserved for corridors whose endpoints someone has actually checked.
// A lane with plausible-looking URLs that nobody has confirmed is amber, not
// green — the badge reports what we know, not what the YAML claims.
//
// `satisfies Record<LivenessState, …>`: adding a state to the liveness model is a
// compile error here until it has a badge, and the legend reads the same map.
export const BADGE = {
  proven: { variant: "success", Icon: CircleCheck, label: "proven" },
  verified: { variant: "success", Icon: CircleCheck, label: "verified" },
  unverified: { variant: "warning", Icon: CircleHelp, label: "unverified" },
  "not-runnable": { variant: "default", Icon: CircleSlash, label: "not runnable" },
} as const satisfies Record<LivenessState, BadgeConfig>;

export function LivenessBadge({ state }: { state: LivenessState }) {
  const badge = BADGE[state];
  return (
    <Badge variant={badge.variant}>
      <badge.Icon size={12} aria-hidden /> {badge.label}
    </Badge>
  );
}
