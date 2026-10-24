// @corridor/service — a thin HTTP layer over the engine. The engine is a
// library; this turns it into a service with the things a real endpoint needs:
// JSON in/out, sensible HTTP status mapping, optional API-key auth, a simple
// in-memory rate limiter, and a request id that comes back on the response and
// goes into every log line and audit entry the request produced. Zero runtime
// dependencies — Node's built-in http.
//
// The core is a pure `route()` you can unit-test without binding a socket;
// `server()` is a thin node:http adapter around it.

import {
  createServer as httpCreateServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import * as crypto from "node:crypto";
import type { Corridor } from "@corridor/manifest";
import { execute, type EngineDeps } from "@corridor/engine";
import {
  constantTimeEqual,
  err,
  isSettleableAmount,
  ok,
  type CorridorErrorCode,
  type Outcome,
  type PartyRef,
  type PaymentIntent,
} from "@corridor/types";

export interface RateLimitOptions {
  /** Bucket size (max burst). */
  capacity: number;
  /** Tokens refilled per second. */
  refillPerSec: number;
}

/**
 * Pluggable rate limiter. The default `TokenBucket` is per-process — fine for a
 * single replica. For multiple replicas, inject a shared implementation (e.g. a
 * Redis token bucket via a Lua script) so the limit is enforced across the
 * fleet rather than per-instance. `take()` may be sync or async (Redis is
 * async). See docs/operations.md §5.
 */
export interface RateLimiter {
  /** Consume one unit for `key`. Return false to reject (429). */
  take(key: string): boolean | Promise<boolean>;
}

/**
 * A single named readiness check. `check()` must resolve when the dependency is
 * healthy and throw (or reject) when it is not. Throwing with an `Error` is
 * preferred so the log entry carries a message; the body returned to callers
 * never includes the error text.
 */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export interface ServiceOptions {
  /** Corridor manifests, keyed by corridor id. */
  corridors: Map<string, Corridor>;
  /** Engine dependencies (resolver, submitter, store, …). */
  deps: EngineDeps;
  /** If set, requests must carry `Authorization: Bearer <key>` with a known key. */
  apiKeys?: Set<string>;
  /** If set, requests are rate-limited per client (API key, else resolved client IP)
   *  using the default in-process TokenBucket. Ignored when `rateLimiter` is given. */
  rateLimit?: RateLimitOptions;
  /** Inject a custom (e.g. shared/Redis) limiter. Takes precedence over `rateLimit`. */
  rateLimiter?: RateLimiter;
  /**
   * If set, `GET /metrics` serves Prometheus text exposition (public + unmetered).
   * Pass `() => prometheusMetrics.render()` and hand the SAME `PrometheusMetrics`
   * to the engine as `deps.metrics` so scrapes see live counters/timings.
   */
  metricsText?: () => string;
  /** Max request body size in bytes. Larger bodies are rejected with 413. Default 64 KiB. */
  maxBodyBytes?: number;
  /**
   * Trust `X-Forwarded-For` for the client IP. Default `false`: the header is
   * client-controlled, so trusting it lets an attacker forge a fresh identity
   * per request and slip the rate limiter. Enable ONLY when a trusted reverse
   * proxy (your ingress) sets the header and strips any inbound value. When
   * false, the transport uses the socket's peer address instead.
   */
  trustProxy?: boolean;
  now?: () => number;
  /**
   * Optional list of readiness checks. `GET /readyz` runs each with a 5-second
   * timeout and returns 200 when all pass, 503 when any fails. The response body
   * lists per-check pass/fail status but never exposes internal error messages.
   * While the service is draining (after `gracefulShutdown()` is called) `/readyz`
   * always returns 503 so load balancers stop routing new traffic immediately.
   */
  readinessChecks?: ReadinessCheck[];
  /**
   * Timeout in milliseconds for each individual readiness check. Default 5000 ms.
   */
  readinessTimeoutMs?: number;
}

/** Default cap on a buffered request body. A payment intent is well under 1 KiB. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** Default per-check timeout for /readyz. */
const DEFAULT_READINESS_TIMEOUT_MS = 5_000;

/**
 * Build a `ReadinessCheck` for a `PostgresIdempotencyStore` (or any object with
 * a `ping(): Promise<void>` method). Wire this into `ServiceOptions.readinessChecks`
 * so `/readyz` reports store reachability before the load balancer routes traffic:
 *
 *   const store = new PostgresIdempotencyStore(pool);
 *   createService({ …, readinessChecks: [storeCheck(store)] });
 */
export function storeCheck(store: { ping(): Promise<void> }, name = "store"): ReadinessCheck {
  return { name, check: () => store.ping() };
}

export interface RouteResponse {
  status: number;
  body: unknown;
  /** Defaults to application/json (body is JSON-encoded). Set e.g. text/plain to
   *  send a string body verbatim (used by /metrics). */
  contentType?: string;
  /** Response headers (lower-cased names) the transport merges into the reply.
   *  `route()` always sets `x-request-id` here so a caller can correlate its own
   *  logs with the lines the request produced. */
  headers?: Record<string, string>;
}

export interface RouteRequest {
  method: string;
  path: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** Resolved client IP from the transport (see `trustProxy`). Used for rate-limit keying. */
  clientIp?: string;
  /**
   * Request id already assigned by the transport, so `server()` can answer its
   * own error paths (413, invalid JSON, the 500 catch) with the same id the
   * route will log under. Ignored when absent: `route()` then takes
   * `x-request-id` from the headers, or mints one.
   */
  requestId?: string;
  /** Validated W3C `traceparent` resolved by the transport. Same fallback rule. */
  traceparent?: string;
}

/**
 * An inbound request id is echoed only if it looks like one: bounded so it can
 * go into a log field or a Postgres column without surprises, and restricted to
 * a charset that cannot inject a header line break or smuggle markup into a log
 * shipper. Anything else is replaced, never rejected — refusing a request over
 * its own correlation id is a bad trade.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * W3C traceparent, exactly: `version-trace-id-parent-id-flags`. Accepted so the
 * id survives into logs and audit entries; full tracing (spans, sampling,
 * export) belongs to the OTel integration, not to this thin layer.
 */
const TRACEPARENT_PATTERN = /^[0-9a-fA-F]{2}-[0-9a-fA-F]{32}-[0-9a-fA-F]{16}-[0-9a-fA-F]{2}$/;

/** Echo a well-formed inbound id, or mint a fresh one. Never throws. */
const resolveRequestId = (inbound: string | undefined): string =>
  inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();

/** Pass a well-formed traceparent through; drop anything else. */
const resolveTraceparent = (inbound: string | undefined): string | undefined =>
  inbound && TRACEPARENT_PATTERN.test(inbound) ? inbound : undefined;

/** The per-request correlation ids every response echoes and every log line carries. */
interface RequestContext {
  readonly requestId: string;
  readonly traceparent?: string;
}

const requestHeaders = (ctx: RequestContext): Record<string, string> => ({
  "x-request-id": ctx.requestId,
  ...(ctx.traceparent ? { traceparent: ctx.traceparent } : {}),
});

/**
 * Resolve the request context: what the transport already decided wins, then the
 * inbound headers, then a freshly minted uuid.
 */
const contextOf = (req: RouteRequest): RequestContext => {
  const headers = req.headers ?? {};
  const requestId = resolveRequestId(req.requestId ?? headers["x-request-id"]);
  const traceparent = resolveTraceparent(req.traceparent ?? headers["traceparent"]);
  return { requestId, ...(traceparent ? { traceparent } : {}) };
};

const STATUS_BY_CODE: Record<CorridorErrorCode, number> = {
  MANIFEST_INVALID: 422,
  MANIFEST_CHANGED: 409,
  CAPABILITY_MISMATCH: 422,
  AMOUNT_INVALID: 422,
  QUOTE_UNAVAILABLE: 502,
  QUOTE_EXPIRED: 409,
  KYC_REQUIRED: 409,
  KYC_REJECTED: 403,
  ANCHOR_UNAVAILABLE: 502,
  SETTLEMENT_FAILED: 500,
  SETTLEMENT_TIMEOUT: 504,
  REFUND_UNSUPPORTED: 501,
  RECONCILE_MISMATCH: 500,
  RECONCILE_STALLED: 504,
  IDEMPOTENCY_CONFLICT: 409,
  PRESETTLE_ANCHOR_DRIFT: 502,
  PRESETTLE_TX_MISMATCH: 409,
  PRESETTLE_DESTINATION_UNSAFE: 422,
  PRESETTLE_INSUFFICIENT_FUNDS: 422,
  PRESETTLE_QUOTE_WINDOW: 409,
  PRESETTLE_AMOUNT_OUT_OF_RANGE: 422,
  PRESETTLE_RECEIVER_NOT_ACCEPTED: 403,
  CORRIDOR_UNPROVEN: 422,
  // The lane halted itself after repeated failures. 503 rather than 409: the
  // request was well-formed and the same one would be accepted again once the
  // lane is reset, so this is a dependency being unavailable, not a conflict
  // the caller can resolve.
  CORRIDOR_HALTED: 503,
  ENGINE_MISCONFIGURED: 500,
  // The HTTP API never starts a dry run, so this only keeps the table total.
  // 409, not 2xx: no payment was made, and the key is spent.
  DRY_RUN_COMPLETE: 409,
  // The resolver would not route the payment (e.g. an unattested anchor). 503,
  // like CORRIDOR_HALTED: a well-formed request refused because no trusted
  // route is available, not a fault in the caller's input or in this server.
  ROUTE_REFUSED: 503,
};

/** Token-bucket rate limiter, keyed per client. In-memory; swap for Redis at scale. */
export class TokenBucket implements RateLimiter {
  private readonly state = new Map<string, { tokens: number; last: number }>();
  /**
   * How long an idle bucket takes to refill back to full capacity. Once a bucket
   * has been idle that long it's indistinguishable from a brand-new one, so it
   * can be dropped — this is what bounds memory. `Infinity` when refill is
   * disabled (a drained bucket never recovers, so we must never evict it).
   */
  private readonly fullRefillMs: number;
  private lastSweep = 0;

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number,
  ) {
    this.fullRefillMs =
      opts.refillPerSec > 0 ? (opts.capacity / opts.refillPerSec) * 1000 : Infinity;
  }

  take(key: string): boolean {
    const t = this.now();
    // Without eviction the map grows once per distinct client (API key, or a
    // spoofable x-forwarded-for) and never shrinks — an unbounded-memory vector.
    // Sweep at most once per refill window so the cost stays amortized O(1).
    this.evictFullyRefilled(t);
    const s = this.state.get(key) ?? { tokens: this.opts.capacity, last: t };
    s.tokens = Math.min(
      this.opts.capacity,
      s.tokens + ((t - s.last) / 1000) * this.opts.refillPerSec,
    );
    s.last = t;
    const allowed = s.tokens >= 1;
    if (allowed) s.tokens -= 1;
    this.state.set(key, s);
    return allowed;
  }

  /** Drop buckets idle long enough to have fully refilled (behaviour-neutral:
   *  a full bucket and a fresh one are identical). Throttled to one pass per
   *  refill window to keep the hot path cheap. */
  private evictFullyRefilled(t: number): void {
    if (!Number.isFinite(this.fullRefillMs)) return;
    if (t - this.lastSweep < this.fullRefillMs) return;
    this.lastSweep = t;
    for (const [k, s] of this.state) {
      if (t - s.last >= this.fullRefillMs) this.state.delete(k);
    }
  }
}

/** A rejected payment body, pointing at the offending input so the caller can
 *  fix exactly that field instead of re-reading the whole schema. */
export interface PaymentBodyError {
  /** Path of the offending input, e.g. "idempotencyKey", "sender.sep12Id",
   *  "destinationFields.routing". `<body>` for a body that is not an object. */
  readonly field: string;
  /** Why it was rejected. Deliberately generic: no anchor internals, no echo
   *  of the offending value beyond its name. */
  readonly reason: string;
}

/** The only top-level fields POST /payments accepts. Unknown keys are refused
 *  rather than ignored: a silently-dropped field is a caller debugging a typo
 *  against an engine that never saw their input. */
const PAYMENT_FIELDS = new Set([
  "idempotencyKey",
  "corridorId",
  "sender",
  "recipient",
  "sourceAmount",
  "destinationFields",
]);

/** idempotencyKey becomes a Postgres primary key and a log field. Bounded and
 *  charset-checked here the same way the web route bounds it (web/app/api/payments/route.ts):
 *  1-128 chars of [A-Za-z0-9._:-]. Same rule as the web proxy so the two
 *  refuse the SAME bodies — a body one layer accepts and the other rejects is
 *  a support ticket waiting to happen. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

const MAX_IDEMPOTENCY_KEY = 128;
const MAX_CORRIDOR_ID = 128;
const MAX_DESTINATION_FIELD_KEYS = 50;
const MAX_DESTINATION_FIELD_VALUE = 256;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const reject = (field: string, reason: string) => err({ field, reason });

/** Optional string fields a party may carry. `sep12Id` is the deprecated alias
 *  of `anchorCustomerId`; both are accepted (#193). */
const PARTY_STRING_FIELDS = ["jurisdiction", "sep12Id", "anchorCustomerId"] as const;

/** Sanity-check one party object (sender/recipient): the id must be a real,
 *  non-empty string and the optional fields must at least be strings. */
function parseParty(
  v: unknown,
  field: "sender" | "recipient",
): Outcome<PartyRef, PaymentBodyError> {
  if (!isPlainObject(v)) {
    return reject(field, "expected an object with a string id");
  }
  for (const key of Object.keys(v)) {
    if (key !== "id" && !(PARTY_STRING_FIELDS as readonly string[]).includes(key)) {
      return reject(`${field}.${key}`, "unknown field");
    }
  }
  if (typeof v.id !== "string") {
    return reject(`${field}.id`, "expected a string");
  }
  if (v.id.length === 0) {
    return reject(`${field}.id`, "must not be empty");
  }
  for (const key of PARTY_STRING_FIELDS) {
    if (v[key] !== undefined && typeof v[key] !== "string") {
      return reject(`${field}.${key}`, "expected a string");
    }
  }
  const party: PartyRef = {
    id: v.id,
    ...(typeof v.jurisdiction === "string" ? { jurisdiction: v.jurisdiction } : {}),
    ...(typeof v.sep12Id === "string" ? { sep12Id: v.sep12Id } : {}),
    ...(typeof v.anchorCustomerId === "string"
      ? { anchorCustomerId: v.anchorCustomerId }
      : {}),
  };
  return ok(party);
}

/**
 * Parse POST /payments bodies strictly, replacing the old `isPaymentBody`
 * six-field spot check, which only proved six properties were strings and
 * then handed the rest to the engine. Every field is bounded, every shape is
 * named, unknown top-level keys are refused, and a failure always carries
 * `{field, reason}` so the caller fixes the one input at fault instead of
 * guessing. Reasons stay free of anchor internals (same rule the engine's
 * error mapping follows): field names and bounds, never upstream URLs or
 * response bodies.
 */
export function parsePaymentBody(o: unknown): Outcome<PaymentIntent, PaymentBodyError> {
  if (!isPlainObject(o)) {
    return reject("<body>", "expected a JSON object");
  }
  for (const key of Object.keys(o)) {
    if (!PAYMENT_FIELDS.has(key)) {
      return reject(key, "unknown field");
    }
  }

  const idempotencyKey = o.idempotencyKey;
  if (typeof idempotencyKey !== "string") {
    return reject("idempotencyKey", "expected a string");
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return reject("idempotencyKey", "must be 1-128 characters of [A-Za-z0-9._:-]");
  }
  if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY) {
    return reject("idempotencyKey", `must be at most ${MAX_IDEMPOTENCY_KEY} characters`);
  }

  const corridorId = o.corridorId;
  if (typeof corridorId !== "string") {
    return reject("corridorId", "expected a string");
  }
  if (corridorId.length === 0 || corridorId.length > MAX_CORRIDOR_ID) {
    return reject("corridorId", `must be 1-${MAX_CORRIDOR_ID} characters`);
  }

  const senderParty = parseParty(o.sender, "sender");
  if (!senderParty.ok) return senderParty;
  const recipientParty = parseParty(o.recipient, "recipient");
  if (!recipientParty.ok) return recipientParty;
  const sender = senderParty.value;
  const recipient = recipientParty.value;

  const rawSourceAmount = o.sourceAmount;
  if (!isPlainObject(rawSourceAmount)) {
    return reject("sourceAmount", "expected an object with asset and amount strings");
  }
  if (typeof rawSourceAmount.asset !== "string") {
    return reject("sourceAmount.asset", "expected a string");
  }
  if (rawSourceAmount.asset.length === 0) {
    return reject("sourceAmount.asset", "must not be empty");
  }
  if (typeof rawSourceAmount.amount !== "string") {
    return reject("sourceAmount.amount", "expected a string");
  }
  const sourceAmount = { asset: rawSourceAmount.asset, amount: rawSourceAmount.amount };

  let destinationFields: Record<string, string> | undefined;
  if ("destinationFields" in o && o.destinationFields !== undefined) {
    const df = o.destinationFields;
    if (!isPlainObject(df)) {
      return reject(
        "destinationFields",
        "expected a flat object of string values (Record<string,string>)",
      );
    }
    const keys = Object.keys(df);
    if (keys.length > MAX_DESTINATION_FIELD_KEYS) {
      return reject(
        "destinationFields",
        `must have at most ${MAX_DESTINATION_FIELD_KEYS} keys`,
      );
    }
    destinationFields = {};
    for (const key of keys) {
      const value = df[key];
      if (typeof value !== "string") {
        return reject(`destinationFields.${key}`, "expected a string value");
      }
      if (value.length > MAX_DESTINATION_FIELD_VALUE) {
        return reject(
          `destinationFields.${key}`,
          `must be at most ${MAX_DESTINATION_FIELD_VALUE} characters`,
        );
      }
      destinationFields[key] = value;
    }
  }

  return ok({
    idempotencyKey,
    corridorId,
    sender,
    recipient,
    sourceAmount,
    ...(destinationFields ? { destinationFields } : {}),
  });
}

/** Asset the body must name: what the sender puts in, i.e. the corridor's
 *  source asset / bridge asset. Checked AFTER the corridor is looked up, so it
 *  compares against the manifest rather than anything the caller supplied. */
function assetMatchesCorridor(asset: string, corridor: Corridor): boolean {
  return asset === corridor.source.asset || asset === corridor.settlement.bridge_asset;
}

export interface Service {
  route(req: RouteRequest): Promise<RouteResponse>;
  /** A node:http server that delegates to route(). Call .listen(port). */
  server(): ReturnType<typeof httpCreateServer>;
  /**
   * Signal the service to start draining. After this call:
   * - `GET /readyz` returns 503 immediately (load balancers stop routing).
   * - New `POST /payments` return 503 `{error:"draining"}`.
   * - In-flight `execute()` calls are allowed to finish.
   * Returns a Promise that resolves once all in-flight executions have settled.
   */
  drain(): Promise<void>;
  /** Idempotency keys of the `execute()` calls still running right now. */
  inFlightKeys(): string[];
}

export function createService(options: ServiceOptions): Service {
  const now = options.now ?? (() => Date.now());
  const limiter: RateLimiter | undefined =
    options.rateLimiter ??
    (options.rateLimit ? new TokenBucket(options.rateLimit, now) : undefined);
  const cbVerifier = new CallbackVerifier();
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;

  // --- draining state --------------------------------------------------
  // Set true by drain(). Once set it is never cleared: a draining instance
  // keeps its load-balancer weight at zero and rejects new payments until the
  // process exits.
  let draining = false;

  // Track every in-flight execute() promise so drain() can wait for them all.
  // Keys are idempotency keys (for logging on grace-timer fire).
  const inFlight = new Map<string, Promise<unknown>>();

  function trackExecution(idempotencyKey: string, p: Promise<unknown>): void {
    inFlight.set(idempotencyKey, p);
    void p.finally(() => inFlight.delete(idempotencyKey));
  }

  function drain(): Promise<void> {
    draining = true;
    if (inFlight.size === 0) return Promise.resolve();
    return Promise.all([...inFlight.values()]).then(() => undefined);
  }

  // Rate-limit identity: a VALIDATED API key if present (most specific), else
  // the client IP resolved by the transport.
  //
  // The key must be one we actually recognise. Keying off the raw bearer let a
  // client mint a fresh bucket per request just by rotating the token — with
  // auth disabled (the documented dev mode) the limiter was a no-op, and each
  // forged token also left a map entry behind until the next sweep. An
  // unrecognised bearer now falls through to the IP bucket, which a client
  // cannot forge. Same reasoning as X-Forwarded-For, which server() only honours
  // under `trustProxy`.
  const clientKey = (req: RouteRequest): string => {
    const key = bearer(req.headers);
    if (key && matchesKey(options.apiKeys, key)) return `key:${key}`;
    return `ip:${req.clientIp ?? "anon"}`;
  };

  async function route(req: RouteRequest): Promise<RouteResponse> {
    // The id is resolved here, before anything else, so even a request that
    // never reaches a handler (unknown path, 401) comes back with the same id
    // its own log lines were written under.
    const ctx = contextOf(req);
    const out = await handle(req, ctx);
    return { ...out, headers: { ...(out.headers ?? {}), ...requestHeaders(ctx) } };
  }

  async function handle(req: RouteRequest, ctx: RequestContext): Promise<RouteResponse> {
    const headers = req.headers ?? {};
    const path = req.path.replace(/\/+$/, "") || "/";

    // Health is public and unmetered. Always 200 — liveness only.
    if (req.method === "GET" && path === "/healthz") {
      return { status: 200, body: { status: "ok" } };
    }

    // Readiness is public and unmetered. Returns 503 while draining or when any
    // check fails, 200 when all checks pass. The body lists per-check results but
    // never surfaces internal error messages — no anchor URLs, no stack traces.
    if (req.method === "GET" && path === "/readyz") {
      if (draining) {
        return { status: 503, body: { status: "draining", checks: [] } };
      }
      const checks = options.readinessChecks ?? [];
      const results = await Promise.all(
        checks.map(async ({ name, check }) => {
          try {
            await Promise.race([
              check(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), readinessTimeoutMs),
              ),
            ]);
            return { name, ok: true };
          } catch {
            return { name, ok: false };
          }
        }),
      );
      const allOk = results.every((r) => r.ok);
      return {
        status: allOk ? 200 : 503,
        body: { status: allOk ? "ok" : "degraded", checks: results },
      };
    }

    // Metrics are public and unmetered (scrapers don't carry an API key). Only
    // exposed when a renderer is configured.
    if (req.method === "GET" && path === "/metrics" && options.metricsText) {
      return {
        status: 200,
        body: options.metricsText(),
        contentType: "text/plain; version=0.0.4",
      };
    }

    // --- rate limit ---
    // BEFORE auth, deliberately. Returning 401 first meant failed credentials
    // were never metered, so API keys could be brute-forced at line rate — a
    // wrong key cost the attacker nothing. An unrecognised bearer keys to the
    // caller's IP bucket (see clientKey), so guessing is now rate-limited per
    // client while legitimate keyed traffic keeps its own bucket.
    if (limiter && !(await limiter.take(clientKey(req)))) {
      return { status: 429, body: { error: "rate_limited" } };
    }

    // --- auth ---
    const presentedKey = bearer(headers);
    if (options.apiKeys) {
      if (!matchesKey(options.apiKeys, presentedKey)) {
        return { status: 401, body: { error: "unauthorized" } };
      }
    }

    // --- POST /payments ---
    if (req.method === "POST" && path === "/payments") {
      // Refuse new payments while draining. In-flight ones that already started
      // will run to completion; only new arrivals are blocked.
      if (draining) {
        return { status: 503, body: { error: "draining" } };
      }
      const parsed = parsePaymentBody(req.body);
      if (!parsed.ok) {
        // Always with `{field, reason}`: a bare "invalid payment body" left
        // callers guessing which of their inputs the engine objected to.
        return {
          status: 400,
          body: {
            error: "invalid payment body",
            field: parsed.error.field,
            reason: parsed.error.reason,
          },
        };
      }
      const intent = parsed.value;
      // isSettleableAmount, not isValidAmount: the latter is a signed syntax
      // check (subAmounts needs negatives) and let "-100.00" through to the
      // engine, which settled it.
      if (!isSettleableAmount(intent.sourceAmount.amount)) {
        return {
          status: 422,
          body: {
            error: "AMOUNT_INVALID",
            field: "sourceAmount.amount",
            message: "amount must be a positive decimal",
          },
        };
      }
      const corridor = options.corridors.get(intent.corridorId);
      if (!corridor) {
        return {
          status: 404,
          body: { error: "unknown corridor", corridorId: intent.corridorId },
        };
      }
      // Asset match AFTER the corridor lookup: the body says what asset it
      // claims to be denominated in, the manifest is the authority on what this
      // lane actually settles. Without this, a body naming the wrong asset was
      // accepted and handed to the anchor to discover at quote time.
      if (!assetMatchesCorridor(intent.sourceAmount.asset, corridor)) {
        return {
          status: 422,
          body: {
            error: "AMOUNT_INVALID",
            field: "sourceAmount.asset",
            message: "asset does not match the corridor's source or bridge asset",
          },
        };
      }
      // Owner comes from the VALIDATED bearer, never from the body — a client
      // must not be able to claim another tenant's runs by asking.
      // The request id travels with it: every log line and audit entry the run
      // produces is stamped with the same id this response echoes.
      const p = execute(intent, corridor, options.deps, {
        owner: presentedKey,
        requestId: ctx.requestId,
        ...(ctx.traceparent ? { traceparent: ctx.traceparent } : {}),
      });
      trackExecution(intent.idempotencyKey, p);
      const result = await p;
      if (result.ok) {
        return { status: 200, body: result.value };
      }
      return {
        status: STATUS_BY_CODE[result.error.code] ?? 500,
        body: { error: result.error.code, message: result.error.message },
      };
    }

    // --- POST /callbacks/sep31/:corridorId ---
    const cbMatch = path.match(/^\/callbacks\/sep31\/([^/]+)$/);
    if (req.method === "POST" && cbMatch) {
      const corridorId = decodeURIComponent(cbMatch[1]);
      const corridor = options.corridors.get(corridorId);
      if (!corridor) {
        return { status: 404, body: { error: "unknown corridor" } };
      }
      const sigHeader = headers["signature"] || headers["x-stellar-signature"];
      if (!sigHeader) {
        return { status: 401, body: { error: "missing signature header" } };
      }
      // Linear-time parse (no backtracking regex): "t=<unix>, s=<base64>".
      const commaAt = sigHeader.indexOf(",");
      const tPart = commaAt < 0 ? "" : sigHeader.slice(0, commaAt).trim();
      const sPart = commaAt < 0 ? "" : sigHeader.slice(commaAt + 1).trim();
      if (!tPart.startsWith("t=") || !sPart.startsWith("s=") || sigHeader.length > 2048) {
        return { status: 401, body: { error: "invalid signature format" } };
      }
      const tStr = tPart.slice(2);
      const s = sPart.slice(2);
      if (!/^\d{1,15}$/.test(tStr) || s.length === 0) {
        return { status: 401, body: { error: "invalid signature format" } };
      }
      const t = parseInt(tStr, 10);
      const currentT = Math.floor(now() / 1000);
      if (isNaN(t) || Math.abs(currentT - t) > 120) {
        return { status: 401, body: { error: "signature expired or invalid timestamp" } };
      }
      const payload = Buffer.from(tStr + "." + (req.rawBody ?? ""));
      const valid = await cbVerifier.verify(corridor.dest.endpoints.home_domain, payload, s);
      if (!valid) {
        return { status: 401, body: { error: "invalid signature" } };
      }
      const body = req.body as { transaction?: { id?: string } };
      const txId = body?.transaction?.id;
      if (txId && options.deps.waker) {
        options.deps.waker.wake(txId);
      }
      return { status: 200, body: {} };
    }

    // --- GET /payments/:key ---
    const m = path.match(/^\/payments\/([^/]+)$/);
    if (req.method === "GET" && m) {
      const store = options.deps.idempotency;
      // A caller-chosen idempotency key is often guessable ("demo-0001"), so the
      // key alone cannot be the authorization. Scope the read to the tenant that
      // created the run.
      let key: string;
      try {
        key = decodeURIComponent(m[1]);
      } catch {
        // Malformed percent-encoding — nothing can match it.
        return { status: 404, body: { error: "not found" } };
      }
      const run = store ? await store.get(key) : undefined;
      // 404 rather than 403 on an ownership mismatch: a 403 would confirm the
      // key exists, which is itself the enumeration oracle we are closing.
      if (!run || (options.apiKeys && !ownerMatches(run.owner, presentedKey))) {
        return { status: 404, body: { error: "not found" } };
      }
      return {
        status: 200,
        body: {
          idempotencyKey: run.idempotencyKey,
          corridorId: run.corridorId,
          state: run.state,
          transactionId: run.transactionId,
          stellarTxHash: run.stellarTxHash,
          // Only the error CODE, never the stored message: lastError is
          // `${code}: ${message}` and the message carries anchor URLs, upstream
          // HTTP bodies and other internals the caller has no business seeing.
          error: errorCode(run.lastError),
        },
      };
    }

    return { status: 404, body: { error: "not found" } };
  }

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  function server() {
    return httpCreateServer((incoming: IncomingMessage, res: ServerResponse) => {
      // Headers first, before a single body byte: the transport's own failure
      // paths (413, invalid JSON, the 500 catch) must answer with the same
      // request id the rest of the system logs under.
      const headers = flattenHeaders(incoming.headers);
      const ctx = contextOf({ method: incoming.method ?? "GET", path: "/", headers });

      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json", ...requestHeaders(ctx) });
        res.end(JSON.stringify(body));
      };

      // Reject oversized bodies up front when the client declares Content-Length,
      // before reading a single byte.
      const declared = Number(incoming.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        sendJson(413, { error: "payload too large" });
        incoming.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      incoming.on("data", (c: Buffer) => {
        if (aborted) return;
        size += c.length;
        // Guard against a lying/absent Content-Length: cap the actual bytes read
        // so a stream can't exhaust memory.
        if (size > maxBodyBytes) {
          aborted = true;
          sendJson(413, { error: "payload too large" });
          incoming.destroy();
          return;
        }
        chunks.push(c);
      });
      incoming.on("end", async () => {
        if (aborted) return;
        let body: unknown;
        const raw = Buffer.concat(chunks).toString("utf8");
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(400, { error: "invalid JSON" });
            return;
          }
        }
        const url = new URL(incoming.url ?? "/", "http://localhost");
        try {
          const out = await route({
            method: incoming.method ?? "GET",
            path: url.pathname,
            body,
            rawBody: raw,
            headers,
            clientIp: resolveClientIp(incoming, headers, options.trustProxy ?? false),
            requestId: ctx.requestId,
            ...(ctx.traceparent ? { traceparent: ctx.traceparent } : {}),
          });
          res.writeHead(out.status, {
            "content-type": out.contentType ?? "application/json",
            ...(out.headers ?? {}),
          });
          // Only a route that chose its own content type may send a string body
          // verbatim; a JSON response stays JSON, quotes and all.
          res.end(
            out.contentType !== undefined && typeof out.body === "string"
              ? out.body
              : JSON.stringify(out.body),
          );
        } catch {
          // An unexpected throw (e.g. the idempotency DB is unreachable) must not
          // hang the socket or crash the process. A throw here means no payment
          // was committed past its last persisted state, so the run is safe to
          // retry; surface a 500 and let the caller back off. Settlement-time
          // store failures degrade to the same `settling`/IDEMPOTENCY_CONFLICT
          // path as a crash — never a silent double-settle.
          if (!res.headersSent) {
            res.writeHead(500, {
              "content-type": "application/json",
              ...requestHeaders(ctx),
            });
            res.end(JSON.stringify({ error: "internal", message: "unexpected error" }));
          }
        }
      });
    });
  }

  return { route, server, drain, inFlightKeys: () => [...inFlight.keys()] };
}

/** Extract a bearer token from an Authorization header, if present. */
function bearer(headers: Record<string, string> | undefined): string | undefined {
  const auth = headers?.["authorization"];
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

/**
 * Lower-case the incoming headers into the flat `Record<string, string>` the
 * router reads. Repeated headers arrive as arrays and are dropped rather than
 * guessed at — a route must never see a value the peer didn't send unambiguously.
 */
function flattenHeaders(raw: IncomingMessage["headers"]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") headers[k.toLowerCase()] = v;
  }
  return headers;
}

/** `Set.has()` short-circuits on hash-bucket lookup, which leaks timing
 *  about the presented key. Iterate and compare every candidate in constant
 *  time instead — the set of configured API keys is small (operator-sized,
 *  not user-sized), so this stays cheap. */
function matchesKey(keys: Set<string> | undefined, presented: string | undefined): boolean {
  if (!keys || !presented) return false;
  let matched = false;
  for (const key of keys) {
    if (constantTimeEqual(key, presented)) matched = true;
  }
  return matched;
}

/** Same constant-time treatment for the ownership check on GET /payments/:key. */
function ownerMatches(owner: string | undefined, presented: string | undefined): boolean {
  if (owner === undefined || presented === undefined) return false;
  return constantTimeEqual(owner, presented);
}

/** `lastError` is stored as "CODE: message". Surface only the code — the message
 *  carries anchor URLs and upstream response text that must not leave the box. */
function errorCode(lastError: string | undefined): string | undefined {
  if (!lastError) return undefined;
  const idx = lastError.indexOf(":");
  return idx > 0 ? lastError.slice(0, idx) : lastError;
}

/** First hop in an X-Forwarded-For list (the original client). */
function firstForwarded(xff: string | undefined): string | undefined {
  const first = xff?.split(",")[0]?.trim();
  return first || undefined;
}

/**
 * Resolve the client IP for rate-limit keying. With `trustProxy`, prefer the
 * left-most X-Forwarded-For entry set by a trusted ingress; otherwise use the
 * socket peer address, which a client cannot forge.
 */
function resolveClientIp(
  incoming: IncomingMessage,
  headers: Record<string, string>,
  trustProxy: boolean,
): string | undefined {
  if (trustProxy) {
    const fwd = firstForwarded(headers["x-forwarded-for"]);
    if (fwd) return fwd;
  }
  return incoming.socket?.remoteAddress ?? undefined;
}

/**
 * Stop accepting new connections and drain in-flight requests, then force-close
 * any that outlast the grace period. Wire this to SIGTERM/SIGINT in your entry
 * point so a deploy/rollout doesn't sever an in-flight payment mid-settle:
 *
 *   const svc = createService(opts);
 *   const srv = svc.server();
 *   srv.listen(8080);
 *   for (const sig of ["SIGTERM", "SIGINT"] as const) {
 *     process.on(sig, () => void gracefulShutdown(srv, svc).then(() => process.exit(0)));
 *   }
 *
 * Pass `svc` as the second argument so the shutdown sequence:
 *   1. Signals the service to drain — `/readyz` immediately returns 503 and new
 *      POST /payments are rejected, stopping the load balancer from routing new
 *      traffic while existing payments finish.
 *   2. Waits for all in-flight `execute()` calls to settle.
 *   3. Stops the HTTP server from accepting new connections and closes idle sockets.
 *   4. Force-closes any remaining connections once the grace window expires,
 *      logging the idempotency keys still running so operators can investigate.
 */
export function gracefulShutdown(
  srv: ReturnType<typeof httpCreateServer>,
  svcOrOpts?: Service | { graceMs?: number },
  legacyOpts: { graceMs?: number } = {},
): Promise<void> {
  // Support both old signature gracefulShutdown(srv, opts) and new
  // gracefulShutdown(srv, svc, opts) so existing callers keep working.
  let svc: Service | undefined;
  let opts: { graceMs?: number };
  if (svcOrOpts && "drain" in svcOrOpts) {
    svc = svcOrOpts as Service;
    opts = legacyOpts;
  } else {
    svc = undefined;
    opts = (svcOrOpts as { graceMs?: number } | undefined) ?? {};
  }

  const graceMs = opts.graceMs ?? 10_000;

  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    // 1. Tell the service to drain — /readyz goes 503 and new payments are
    //    blocked immediately, before we wait for anything.
    if (svc) void svc.drain();

    // 2. Stop accepting new HTTP connections; wait for existing ones to close.
    srv.close(() => done());
    // Free idle keep-alive sockets so srv.close() can complete promptly.
    srv.closeIdleConnections?.();

    // 3. Backstop: after the grace window, force-close everything still open.
    const timer = setTimeout(() => {
      // Log the keys still running so operators know what was mid-settle when we cut.
      if (svc) {
        const keys = svc.inFlightKeys();
        process.stderr.write(
          `[corridor/service] graceful-shutdown grace period (${graceMs}ms) expired, ` +
            `force-closing connections. In-flight idempotency keys: ` +
            `${keys.length > 0 ? keys.join(", ") : "none"}\n`,
        );
      }
      srv.closeAllConnections?.();
      done();
    }, graceMs);
    timer.unref?.();
  });
}

function decodeBase32(str: string): Buffer {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const buf = Buffer.alloc(Math.ceil((str.length * 5) / 8));
  let bits = 0,
    val = 0,
    idx = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "=") break;
    val = (val << 5) | ALPHABET.indexOf(str[i]);
    bits += 5;
    if (bits >= 8) {
      buf[idx++] = (val >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return buf.subarray(0, idx);
}

export class CallbackVerifier {
  private readonly keys = new Map<string, { key: crypto.KeyObject; expires: number }>();

  async verify(
    homeDomain: string,
    payload: Buffer,
    signatureBase64: string,
  ): Promise<boolean> {
    const now = Date.now();
    let cached = this.keys.get(homeDomain);
    if (!cached || cached.expires < now) {
      try {
        const res = await fetch(`https://${homeDomain}/.well-known/stellar.toml`);
        if (!res.ok) return false;
        const text = await res.text();
        const match = text.match(/^SIGNING_KEY\s*=\s*"([^"]+)"/m);
        if (!match) return false;
        const rawPub = decodeBase32(match[1]).subarray(1, 33);
        const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPub]);
        const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
        cached = { key, expires: now + 5 * 60_000 };
        this.keys.set(homeDomain, cached);
      } catch {
        return false;
      }
    }
    try {
      return crypto.verify(null, payload, cached.key, Buffer.from(signatureBase64, "base64"));
    } catch {
      return false;
    }
  }
}
