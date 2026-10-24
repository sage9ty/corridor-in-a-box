"use client";

import { useEffect, useState } from "react";
import { Clock, TriangleAlert } from "lucide-react";
import { formatDuration, formatUtc } from "@/lib/freshness";

/**
 * When the registry snapshot on the page was read, and how long ago that is.
 *
 * The page is cached for up to `revalidateSeconds`, so "how long ago" has to be
 * worked out in the visitor's browser: computed on the server it would say
 * "just now" for the whole hour the cached HTML is served. Until the effect
 * runs, only the absolute time is shown, which keeps the server and client
 * markup identical.
 */
export function RegistryFreshness({
  network,
  readAt,
  latestLedger,
  revalidateSeconds,
}: {
  network: string;
  readAt: string;
  latestLedger?: number;
  revalidateSeconds: number;
}) {
  const [ageSeconds, setAgeSeconds] = useState<number | undefined>(undefined);

  useEffect(() => {
    const read = Date.parse(readAt);
    const tick = () => setAgeSeconds(Math.max(0, (Date.now() - read) / 1000));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [readAt]);

  // Older than one revalidate window means the refresh did not happen when it
  // should have (a failed rebuild, or a cache that is not revalidating).
  const overdue = ageSeconds !== undefined && ageSeconds > revalidateSeconds;

  return (
    <p
      className={`inline-flex flex-wrap items-center gap-1.5 text-xs ${
        overdue ? "font-medium text-yellow-700 dark:text-yellow-500" : "text-secondary-text"
      }`}
    >
      {overdue ? <TriangleAlert size={13} /> : <Clock size={13} />}
      <span>
        Read from {network} registry at{" "}
        <time dateTime={readAt} className="font-mono">
          {formatUtc(readAt)}
        </time>
        {latestLedger !== undefined && (
          <>
            {" "}
            · ledger <span className="font-mono">{latestLedger.toLocaleString("en-US")}</span>
          </>
        )}
        {ageSeconds !== undefined && ` · ${formatDuration(ageSeconds)} ago`} · refreshes every{" "}
        {formatDuration(revalidateSeconds)}
        {overdue && " · older than expected"}
      </span>
    </p>
  );
}
