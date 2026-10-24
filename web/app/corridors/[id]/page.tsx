import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AlertTriangle, ArrowLeft, ArrowRight, Link2 } from "lucide-react";
import { AnchorCard } from "@/components/AnchorCard";
import { LivenessBadge } from "@/components/LivenessBadge";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import {
  corridors,
  getCorridor,
  liveness,
  LIVENESS_LABEL,
  endpoint,
  type EndpointKey,
} from "@/lib/corridors";
import { fetchAttestations, REGISTRY_ID, REGISTRY_NETWORK } from "@/lib/registry";

// Anchor facts come from the chain, and attestations change on the order of
// hours. Read them at request time and revalidate hourly — baking a build-time
// answer into a page that labels it "on-chain registry" would be the same
// habit the dashboard is trying to break.
export const revalidate = 3600;

export function generateStaticParams() {
  return corridors.map((c) => ({ id: c.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const corridor = getCorridor(id);
  if (!corridor) return { title: "Corridor not found — corridor-in-a-box" };
  return {
    title: `${corridor.id} — corridor-in-a-box`,
    description: `${corridor.source.asset} → ${corridor.dest.asset} via ${corridor.dest.name}.`,
  };
}

/** Manifest field → the stellar.toml key it is copied from, for the endpoints table. */
const ENDPOINT_ROWS: { key: EndpointKey; toml: string }[] = [
  { key: "home_domain", toml: "—" },
  { key: "transfer_server_sep31", toml: "DIRECT_PAYMENT_SERVER" },
  { key: "transfer_server", toml: "TRANSFER_SERVER" },
  { key: "web_auth", toml: "WEB_AUTH_ENDPOINT" },
  { key: "kyc_server", toml: "KYC_SERVER" },
  { key: "quote_server", toml: "ANCHOR_QUOTE_SERVER" },
];

export default async function CorridorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const corridor = getCorridor(id);
  if (!corridor) notFound();

  const live = liveness(corridor);
  const attestations = await fetchAttestations();
  const domain = corridor.dest.endpoints.home_domain;
  const attestation = attestations.anchors.find((a) => a.domain === domain);

  return (
    <div className="flex flex-col gap-10">
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-secondary-text hover:underline"
        >
          <ArrowLeft size={14} /> All corridors
        </Link>
        <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-mono text-3xl font-bold tracking-tight">{corridor.id}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-secondary-text">
              {corridor.fx.path.map((hop, i) => (
                <span key={`${hop}-${i}`} className="flex items-center gap-1.5">
                  <span className="font-medium text-primary-text">{hop}</span>
                  {i < corridor.fx.path.length - 1 && <ArrowRight size={12} />}
                </span>
              ))}
            </div>
          </div>
          <LivenessBadge state={live.state} />
        </div>
      </div>

      {/* Summary */}
      <section className="flex flex-col gap-4">
        <SectionHeading title="Summary" source="manifest" />
        <Card className="flex flex-col gap-5">
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Source anchor" value={corridor.source.name} />
            <Fact label="Destination anchor" value={corridor.dest.name} />
            <Fact label="Source asset" value={corridor.source.asset} mono />
            <Fact label="Destination asset" value={corridor.dest.asset} mono />
            <Fact
              label="Liveness"
              value={`${LIVENESS_LABEL[live.state]} — ${
                live.runnable ? "runnable" : "not runnable"
              }`}
            />
            <Fact
              label="Dest endpoints verified at"
              value={live.verifiedAt ?? "never checked"}
              mono={live.verifiedAt !== undefined}
            />
          </dl>

          {corridor.status_note && (
            <p className="rounded-lg bg-bg-subtle px-3 py-2 text-sm text-secondary-text">
              {corridor.status_note}
            </p>
          )}

          {live.warnings.length > 0 && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 dark:border-yellow-900/50 dark:bg-yellow-900/20">
              <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-yellow-800 dark:text-yellow-500">
                <AlertTriangle size={14} /> Liveness warnings
              </div>
              <ul className="list-disc space-y-1 pl-5 text-sm text-secondary-text">
                {live.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <Link
              href={`/payments?corridor=${corridor.id}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline"
            >
              Run a payment on this corridor <ArrowRight size={14} />
            </Link>
          </div>
        </Card>
      </section>

      {/* Endpoints */}
      <section className="flex flex-col gap-4">
        <SectionHeading title="Endpoints" source="manifest" />
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-secondary-text">
            Copied from each anchor&apos;s published{" "}
            <code className="rounded bg-bg-subtle px-1 py-0.5 text-xs">stellar.toml</code>. A
            non-empty URL is not evidence an endpoint exists — the date below is.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-secondary-text">
                  <th className="py-2 pr-4 font-medium">Field</th>
                  <th className="py-2 pr-4 font-medium">stellar.toml key</th>
                  <th className="py-2 pr-4 font-medium">Source anchor</th>
                  <th className="py-2 font-medium">Destination anchor</th>
                </tr>
              </thead>
              <tbody>
                {ENDPOINT_ROWS.map((row) => (
                  <tr key={row.key} className="border-t border-border align-top">
                    <td className="py-2 pr-4 font-mono text-xs">{row.key}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-secondary-text">
                      {row.toml}
                    </td>
                    <EndpointValue value={endpoint(corridor.source.endpoints, row.key)} />
                    <EndpointValue value={endpoint(corridor.dest.endpoints, row.key)} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-secondary-text">
            Dest{" "}
            <code className="rounded bg-bg-subtle px-1 py-0.5">endpoints_verified_at</code>:{" "}
            <span className="font-mono">
              {corridor.dest.endpoints.endpoints_verified_at ?? "not set (unverified)"}
            </span>
          </p>
        </Card>
      </section>

      {/* FX and settlement */}
      <section className="flex flex-col gap-4">
        <SectionHeading title="FX and settlement" source="manifest" />
        <Card className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="FX path" value={corridor.fx.path.join(" → ")} mono />
          <Fact label="Quote source" value={corridor.fx.quote_source} mono />
          <Fact label="Who holds FX risk" value={corridor.fx.who_holds_risk} mono />
          <Fact label="Quote TTL" value={`${corridor.fx.quote_ttl_seconds}s`} />
          <Fact label="Bridge asset" value={corridor.settlement.bridge_asset} mono />
          <Fact label="Settlement network" value={corridor.settlement.network} mono />
          <Fact label="Asset issuer" value={corridor.settlement.asset_issuer} mono />
        </Card>
      </section>

      {/* Recovery policy */}
      <section className="flex flex-col gap-4">
        <SectionHeading title="Recovery policy" source="manifest" />
        <Card className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Max retries" value={String(corridor.recovery.max_retries)} />
          <Fact label="Corridor timeout" value={`${corridor.recovery.timeout_seconds}s`} />
          <Fact label="Rollback" value={corridor.recovery.rollback} mono />
          <Fact
            label="External stall budget"
            value={`${corridor.recovery.reconcile?.external_stall_seconds ?? 21_600}s${
              corridor.recovery.reconcile?.external_stall_seconds === undefined
                ? " (default)"
                : ""
            }`}
          />
        </Card>
      </section>

      {/* Registry attestation */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionHeading title="Registry attestation" source="on-chain registry" />
          {REGISTRY_ID && (
            <a
              href={`https://stellar.expert/explorer/${REGISTRY_NETWORK}/contract/${REGISTRY_ID}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-secondary-text hover:underline"
            >
              <Link2 size={13} className="text-blue-600" /> verify on chain
            </a>
          )}
        </div>
        <p className="text-sm text-secondary-text">
          Attestation for the destination anchor&apos;s home domain,{" "}
          <span className="font-mono">{domain}</span>. This is the only section sourced from
          the chain; everything above is what the manifest claims.
        </p>

        {!attestations.ok ? (
          <div className="rounded-xl border border-border bg-bg-subtle p-5 text-sm text-secondary-text">
            <div className="mb-1 font-medium text-primary-text">Registry unreachable</div>
            Could not read the registry ({attestations.error}). This is not the same as
            &quot;not attested&quot; — no claim is made about{" "}
            <span className="font-mono">{domain}</span> here.
          </div>
        ) : attestation ? (
          <div className="grid gap-4 md:grid-cols-2">
            <AnchorCard anchor={attestation} />
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-bg-subtle p-5 text-sm text-secondary-text">
            <div className="mb-1 font-medium text-primary-text">Not attested</div>
            The registry answered and holds no attestation for{" "}
            <span className="font-mono">{domain}</span>. Nobody has probed this anchor
            on-chain, so there is nothing to show — not a failed probe, and not a passing one.
          </div>
        )}
      </section>
    </div>
  );
}

function SectionHeading({
  title,
  source,
}: {
  title: string;
  source: "manifest" | "on-chain registry";
}) {
  return (
    <div className="flex items-center gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      <Badge variant={source === "manifest" ? "default" : "info"}>{source}</Badge>
    </div>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs uppercase tracking-wide text-secondary-text">{label}</dt>
      <dd className={`mt-0.5 break-words font-medium ${mono ? "font-mono text-sm" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function EndpointValue({ value }: { value: string | undefined }) {
  return (
    <td className="py-2 pr-4 font-mono text-xs break-all">
      {value ?? <span className="text-secondary-text">not set</span>}
    </td>
  );
}
