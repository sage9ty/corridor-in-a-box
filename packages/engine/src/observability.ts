// Observability — structured logs + an append-only audit trail. A payments
// engine must be able to answer "what happened to this payment, and when" after
// the fact, so every state transition is both logged and recorded as an immutable
// audit entry. Both sinks are injected; the engine never reaches for a global.

import type { Money } from "@corridor/types";
import type { CorridorState } from "./state";
import type { LivenessState } from "@corridor/manifest";
import type { CheckResult } from "./gate";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  readonly [key: string]: unknown;
}

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
  /**
   * Optional scoping convention: return a logger that stamps `fields` on every
   * line it emits, so a caller can attach per-request context (a request id, a
   * trace id) once instead of threading it through every call site. Sinks that
   * already keep a structured context (pino, winston) should implement this and
   * return their own child; everyone else gets the merging wrapper from
   * `childLogger`.
   */
  child?(fields: LogFields): Logger;
}

/** A logger that folds `fields` under each line's own, delegating to `base`. */
function mergingLogger(base: Logger, fields: LogFields): Logger {
  return {
    log(level: LogLevel, msg: string, line?: LogFields): void {
      base.log(level, msg, { ...fields, ...line });
    },
  };
}

/**
 * Scope `logger` to `fields`. Uses the sink's own `child()` when it has one
 * (cheaper, and it keeps the sink's real context), otherwise wraps it in a
 * merging logger, so this works with any injected `Logger`.
 */
export function childLogger(logger: Logger, fields: LogFields): Logger {
  return logger.child ? logger.child(fields) : mergingLogger(logger, fields);
}

/** Emits one JSON object per line — friendly to log shippers and grep alike. */
export const consoleLogger: Logger = {
  log(level, msg, fields) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else if (level === "debug") (console.debug ?? console.log)(line);
    else console.log(line);
  },
  child(fields) {
    // A fresh sink per scope rather than a recursion back into `childLogger`.
    return mergingLogger(consoleLogger, fields);
  },
};

/** Drops everything. The default, so tests and libraries stay quiet. */
export const silentLogger: Logger = {
  log() {},
  child() {
    return silentLogger;
  },
};

/**
 * Per-request context the engine stamps on everything a run produces. Kept as a
 * type (not an interface) so it spreads cleanly into `LogFields`.
 */
export type RequestScope = {
  readonly requestId?: string;
  readonly traceparent?: string;
};

/** One immutable record of a single state transition. */
export interface AuditEntry extends LogFields {
  readonly idempotencyKey: string;
  readonly corridorId: string;
  readonly from: CorridorState;
  readonly to: CorridorState;
  readonly version: number;
  readonly at: number;
  readonly error?: string;
  /** Request id the run was started under, when the caller supplied one. */
  readonly requestId?: string;
  /** W3C `traceparent` of the request that started the run, when it had one. */
  readonly traceparent?: string;
  readonly routeTrust?: "attested" | "manifest";
  /** The anchor's SEP-38 fee, in the sell asset. Present on the `settled` entry when the quote carried one. */
  readonly quoteFee?: Money;
  /** Stellar network fee charged for the settlement, in stroops (Horizon `fee_charged`). */
  readonly networkFee?: string;
  readonly amountRefunded?: string;
  readonly amountFee?: string;
  /** Pre-settle gate results, recorded on the `verifying` transition. */
  readonly checks?: readonly CheckResult[];
}

/** Verification decision recorded before the engine claims an idempotency key. */
export interface AuditDetail {
  readonly event: "verifying";
  readonly idempotencyKey: string;
  readonly corridorId: string;
  readonly at: number;
  /** Request id the run was started under, when the caller supplied one. */
  readonly requestId?: string;
  /** W3C `traceparent` of the request that started the run, when it had one. */
  readonly traceparent?: string;
  readonly detail: {
    readonly liveness: LivenessState;
    readonly effectiveCap?: string;
  };
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void> | void;
  recordDetail?(detail: AuditDetail): Promise<void> | void;
}

/**
 * An audit sink that stamps `scope` onto every entry and detail it records, so a
 * whole run's trail can be tied back to the request that started it without
 * every emit site repeating the field.
 */
export function scopedAuditSink(sink: AuditSink, scope: RequestScope): AuditSink {
  return {
    record: (entry) => sink.record({ ...scope, ...entry }),
    ...(sink.recordDetail && {
      recordDetail: (detail) => sink.recordDetail!({ ...scope, ...detail }),
    }),
  };
}

export type AlertKind = "held" | "refund_pending" | "breaker_tripped";

export interface Alert {
  readonly kind: AlertKind;
  readonly corridorId: string;
  readonly idempotencyKey?: string;
  readonly stellarTxHash?: string;
  readonly lastError?: string;
  readonly at: number;
}

/** Notifications are best-effort: an alert sink must never control payment state. */
export interface Alerting {
  raise(alert: Alert): Promise<void> | void;
}

export const noopAlerting: Alerting = { raise() {} };

/** Small test sink; production deployments should inject an alert transport. */
export class InMemoryAlerting implements Alerting {
  readonly alerts: Alert[] = [];
  raise(alert: Alert): void {
    this.alerts.push({ ...alert });
  }
}

/** Webhook transport sends only operational identifiers and never payment PII. */
export class WebhookAlerting implements Alerting {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
      throw new Error("WebhookAlerting requires HTTPS (localhost is allowed for development)");
    }
  }

  async raise(alert: Alert): Promise<void> {
    const response = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(alert),
    });
    if (!response.ok) throw new Error(`alert webhook returned HTTP ${response.status}`);
  }
}

/** In-memory audit log for tests/examples. Back this with an append-only table
 *  (or event stream) in production — never update or delete entries. */
export class InMemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  readonly details: AuditDetail[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
  recordDetail(detail: AuditDetail): void {
    this.details.push(detail);
  }
}

// --- Metrics -------------------------------------------------------------
// A minimal counter/timing sink. Maps cleanly onto StatsD/Prometheus/OTel:
// `increment` → a counter, `timing` → a histogram. Tags become labels.

export interface MetricTags {
  readonly [key: string]: string;
}

export interface Metrics {
  increment(name: string, tags?: MetricTags): void;
  timing(name: string, ms: number, tags?: MetricTags): void;
}

/** Discards everything. The default. */
export const noopMetrics: Metrics = { increment() {}, timing() {} };

export class InMemoryMetrics implements Metrics {
  readonly counters: { name: string; tags?: MetricTags }[] = [];
  readonly timings: { name: string; ms: number; tags?: MetricTags }[] = [];
  increment(name: string, tags?: MetricTags): void {
    this.counters.push({ name, tags });
  }
  timing(name: string, ms: number, tags?: MetricTags): void {
    this.timings.push({ name, ms, tags });
  }
}

// --- Prometheus exposition ----------------------------------------------
// Zero-dependency Prometheus text exposition. Timing samples are histograms
// in seconds.

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function renderLabels(tags?: MetricTags): string {
  const keys = tags ? Object.keys(tags).sort() : [];
  return keys.length
    ? `{${keys.map((key) => `${sanitize(key)}="${escapeLabel(tags![key])}"`).join(",")}}`
    : "";
}

function seriesKey(name: string, tags?: MetricTags): string {
  return name + renderLabels(tags);
}

export interface PrometheusMetricsOptions {
  /** Inclusive upper bounds in seconds. Must be finite, positive and increasing. */
  readonly buckets?: readonly number[];
}

interface CounterSeries {
  name: string;
  labels: string;
  value: number;
}

interface HistogramSeries {
  name: string;
  helpKey: string;
  labels: string;
  count: number;
  sumSeconds: number;
  bucketCounts: number[];
}

const DEFAULT_HISTOGRAM_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

export class PrometheusMetrics implements Metrics {
  private readonly counters = new Map<string, CounterSeries>();
  private readonly timings = new Map<string, HistogramSeries>();
  private readonly help = new Map<string, string>();
  private readonly buckets: readonly number[];

  constructor(options: PrometheusMetricsOptions = {}) {
    const buckets = [...(options.buckets ?? DEFAULT_HISTOGRAM_BUCKETS_SECONDS)];
    if (
      buckets.some((bucket) => !Number.isFinite(bucket) || bucket <= 0) ||
      buckets.some((bucket, index) => index > 0 && bucket <= buckets[index - 1])
    ) {
      throw new RangeError(
        "Prometheus histogram buckets must be finite, positive, and strictly increasing",
      );
    }
    this.buckets = buckets;
  }

  /** Register HELP text for a counter or timing metric. */
  registerHelp(name: string, help: string): void {
    const metricName = sanitize(name);
    if (!metricName || !help.trim()) {
      throw new Error("Prometheus metric name and HELP text must be non-empty");
    }
    this.help.set(metricName, help);
  }

  increment(name: string, tags?: MetricTags): void {
    const key = seriesKey(name, tags);
    const existing = this.counters.get(key);
    if (existing) existing.value += 1;
    else {
      this.counters.set(key, {
        name: sanitize(name),
        labels: renderLabels(tags),
        value: 1,
      });
    }
  }

  timing(name: string, ms: number, tags?: MetricTags): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError("Prometheus timing samples must be finite and non-negative");
    }
    const key = seriesKey(name, tags);
    const seconds = ms / 1000;
    const existing = this.timings.get(key);
    if (existing) {
      existing.count += 1;
      existing.sumSeconds += seconds;
      existing.bucketCounts = existing.bucketCounts.map(
        (count, index) => count + (seconds <= this.buckets[index] ? 1 : 0),
      );
    } else {
      this.timings.set(key, {
        name: `${sanitize(name)}_seconds`,
        helpKey: sanitize(name),
        labels: renderLabels(tags),
        count: 1,
        sumSeconds: seconds,
        bucketCounts: this.buckets.map((bucket) => (seconds <= bucket ? 1 : 0)),
      });
    }
  }

  render(): string {
    const lines: string[] = [];
    const counterNames = new Set([...this.counters.values()].map((counter) => counter.name));
    for (const name of [...counterNames].sort()) {
      lines.push(
        `# HELP ${name} ${escapeHelp(this.help.get(name) ?? `Counter metric ${name}.`)}`,
      );
      lines.push(`# TYPE ${name} counter`);
      for (const counter of this.counters.values()) {
        if (counter.name === name) {
          lines.push(`${counter.name}${counter.labels} ${counter.value}`);
        }
      }
    }

    const timingNames = new Set([...this.timings.values()].map((timing) => timing.name));
    for (const name of [...timingNames].sort()) {
      const series = [...this.timings.values()].filter((timing) => timing.name === name);
      const helpKey = series[0].helpKey;
      const helpText =
        this.help.get(helpKey) ?? `Duration of ${helpKey} operations in seconds.`;
      lines.push(`# HELP ${name} ${escapeHelp(helpText)}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const timing of series) {
        this.buckets.forEach((bucket, index) => {
          const labels = timing.labels
            ? `${timing.labels.slice(0, -1)},le="${bucket}"}`
            : `{le="${bucket}"}`;
          lines.push(`${name}_bucket${labels} ${timing.bucketCounts[index]}`);
        });
        const infLabels = timing.labels
          ? `${timing.labels.slice(0, -1)},le="+Inf"}`
          : `{le="+Inf"}`;
        lines.push(`${name}_bucket${infLabels} ${timing.count}`);
        lines.push(`${name}_sum${timing.labels} ${timing.sumSeconds}`);
        lines.push(`${name}_count${timing.labels} ${timing.count}`);
      }
    }
    return lines.join("\n") + "\n";
  }
}
