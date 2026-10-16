import Link from "next/link";
import { ArrowRight, Boxes, ShieldCheck, Repeat, Activity, Info, Link2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CorridorCard } from "@/components/CorridorCard";
import { AnchorCard } from "@/components/AnchorCard";
import { corridors, liveness } from "@/lib/corridors";
import { fetchAttestations, REGISTRY_ID, REGISTRY_NETWORK } from "@/lib/registry";

// Anchor facts are read from the chain at request time, not baked in at build.
// Revalidate hourly: attestations change on the order of hours, and a page that
// caches them forever would start asserting stale facts as current — the exact
// habit this project is correcting.
export const revalidate = 3600;

export default async function Home() {
  const attestations = await fetchAttestations();
  const verifiedCount = corridors.filter((c) => {
    const state = liveness(c).state;
    return state === "verified" || state === "proven";
  }).length;
  return (
    <div className="flex flex-col gap-16">
      {/* Hero */}
      <section className="flex flex-col items-start gap-5 pt-6">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-subtle px-3 py-1 text-xs font-medium text-secondary-text">
          <Boxes size={13} className="text-blue-600" /> Open SEP-31 corridor engine
        </span>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          A corridor is <span className="text-blue-600">configuration</span>, not code.
        </h1>
        <p className="max-w-2xl text-lg text-secondary-text">
          A manifest-driven engine for Stellar SEP-31 cross-border corridors. It runs{" "}
          <code className="rounded bg-bg-subtle px-1.5 py-0.5 text-sm">
            quote → comply → settle → reconcile → recover
          </code>{" "}
          over any standards-compliant anchor pair — adding a corridor is a new YAML file, not a fork.
        </p>
        <div className="flex gap-3">
          <Link href="/payments">
            <Button size="lg">
              Run a payment <ArrowRight size={18} />
            </Button>
          </Link>
          <Link href="/docs">
            <Button size="lg" variant="secondary">
              Read the docs
            </Button>
          </Link>
        </div>
      </section>

      {/* Features */}
      <section className="grid gap-4 sm:grid-cols-3">
        <Feature
          icon={<Repeat size={20} className="text-blue-600" />}
          title="Idempotent & resumable"
          body="A persisted state machine with crash-resume and fail-closed recovery: a payment that cannot complete is parked as held for a human. Nothing is ever re-sent. The same key never settles twice."
        />
        <Feature
          icon={<ShieldCheck size={20} className="text-blue-600" />}
          title="Standards-native"
          body="One adapter for any SEP-31 anchor — SEP-38 quotes, SEP-10 auth, SEP-12 KYC — and a chain-isolated native settle leg."
        />
        <Feature
          icon={<Activity size={20} className="text-blue-600" />}
          title="Operable"
          body="Structured logs, an append-only audit trail, metrics hooks, KMS-ready signing, and a thin HTTP API."
        />
      </section>

      {/* Anchors — read from the on-chain registry */}
      <section className="flex flex-col gap-5">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">Attested anchors</h2>
            <p className="max-w-2xl text-secondary-text">
              Read from the on-chain registry (refreshed hourly); each card shows the attestation
              ledger. Each card separates what an anchor&apos;s{" "}
              <code className="rounded bg-bg-subtle px-1 py-0.5 text-xs">stellar.toml</code>{" "}
              <em>advertises</em> from what actually <em>worked</em> when it was probed — because
              those are different claims, and treating them as one is how a lane that does not
              exist comes to look healthy.
            </p>
          </div>
          {REGISTRY_ID && (
            <a
              href={`https://stellar.expert/explorer/${REGISTRY_NETWORK}/contract/${REGISTRY_ID}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-bg-subtle px-3 py-1 text-xs font-medium text-secondary-text hover:underline"
            >
              <Link2 size={13} className="text-blue-600" /> verify on chain
            </a>
          )}
        </div>

        {!attestations.ok ? (
          <div className="rounded-xl border border-border bg-bg-subtle p-5 text-sm text-secondary-text">
            Could not reach the registry ({attestations.error}). No anchor data is shown rather
            than stale or assumed data.
          </div>
        ) : attestations.anchors.length === 0 ? (
          <div className="rounded-xl border border-border bg-bg-subtle p-5 text-sm text-secondary-text">
            No anchors have been attested yet.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {attestations.anchors.map((a) => (
              <AnchorCard key={a.domain} anchor={a} />
            ))}
          </div>
        )}
      </section>

      {/* Corridors */}
      <section className="flex flex-col gap-5">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-semibold">Corridors</h2>
            <p className="text-secondary-text">
              The binding constraint is a live receiving anchor, not code. A corridor only shows{" "}
              <span className="font-medium">verified</span> once its endpoints have been confirmed
              against the anchor&apos;s published <code>stellar.toml</code> —{" "}
              {verifiedCount === 0
                ? "none have been yet."
                : `${verifiedCount} of ${corridors.length} ${verifiedCount === 1 ? "has" : "have"} been.`}
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg-subtle px-3 py-1 text-xs font-medium text-secondary-text">
            <Info size={13} className="text-blue-600" /> Manifest snapshot — not a live liveness probe
          </span>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {corridors.map((c) => (
            <CorridorCard key={c.id} corridor={c} />
          ))}
        </div>
      </section>
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-background p-5">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-bg-subtle">
        {icon}
      </div>
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-secondary-text">{body}</p>
    </div>
  );
}
