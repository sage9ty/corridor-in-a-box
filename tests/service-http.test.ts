// Black-box HTTP tests for the service transport.
//
// `tests/service.test.ts` drives the pure `route()` in-process, which is the
// right way to test routing — but it cannot see the code in `server()`: JSON
// parsing, the lowercasing of inbound headers, `resolveClientIp()` /
// `trustProxy`, the content types written on the way out, and the catch-all that
// turns an unexpected throw into a 500 instead of a hung socket. Everything
// below therefore goes over a real socket against `createService(...).server()`,
// with mock adapters and a mock submitter, and asserts on bytes and headers.

import { afterEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { parseCorridor, type Corridor } from "@corridor/manifest";
import { createMockAdapter } from "@corridor/adapter-kit";
import { StaticRouteResolver } from "@corridor/router";
import {
  InMemoryIdempotencyStore,
  createMockSubmitter,
  type EngineDeps,
  type IdempotencyStore,
} from "@corridor/engine";
import {
  createService,
  gracefulShutdown,
  type Service,
  type ServiceOptions,
} from "@corridor/service";
import type { PaymentIntent } from "@corridor/types";

function corridor(): Corridor {
  const r = parseCorridor({
    id: "test",
    source: { name: "S", asset: "USDC", endpoints: { home_domain: "s.example" } },
    dest: {
      name: "D",
      asset: "iso4217:ARS",
      endpoints: {
        home_domain: "d.example",
        transfer_server_sep31: "https://d.example/sep31",
        endpoints_verified_at: "1970-01-01",
      },
    },
    fx: { path: ["ARS", "USDC", "ARS"], who_holds_risk: "receiving_anchor" },
    compliance: { source_jurisdiction: "AR", dest_jurisdiction: "AR" },
    settlement: { network: "public", asset_issuer: "GISSUER" },
    recovery: {},
    proof: {
      canary_completed_at: "1970-01-01T00:00:00Z",
      stellar_tx_hash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      anchor_transaction_id: "canary-test",
      amount: "1",
      max_age_days: 50000,
    },
  });
  if (!r.ok) throw new Error(`fixture invalid: ${JSON.stringify(r.error)}`);
  return r.value;
}

function intentBody(key: string): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

/** Mock lane: no anchor, no chain, no timers — a POST settles in one tick. */
function deps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
    ...over,
  };
}

// --- socket plumbing --------------------------------------------------------

const listening: Array<{ srv: Server; svc: Service }> = [];

/** Bind one service to an ephemeral port and remember it for teardown. */
async function serve(
  over: Partial<ServiceOptions> = {},
): Promise<{ port: number; svc: Service }> {
  const svc = createService({
    corridors: new Map([["test", corridor()]]),
    deps: deps(),
    ...over,
  });
  const srv = svc.server();
  srv.listen(0);
  await once(srv, "listening");
  listening.push({ srv, svc });
  return { port: (srv.address() as AddressInfo).port, svc };
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const json = (body: unknown): { headers: Record<string, string>; body: string } => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * One request, one connection: `agent: false` keeps keep-alive sockets from
 * leaking between tests, so a server closed in teardown can't be blocked by a
 * pooled connection the next test would have reused.
 */
function call(
  port: number,
  method: string,
  path: string,
  opts: { body?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        agent: false,
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });

afterEach(async () => {
  // Graceful shutdown, not `srv.close()`: the in-flight bookkeeping the service
  // keeps is exactly what a bare close() would strand, and a leftover socket
  // would outlive the test and hold the port.
  const closing = listening.splice(0);
  await Promise.all(
    closing.map(({ srv, svc }) => gracefulShutdown(srv, svc, { graceMs: 500 })),
  );
});

describe("service over HTTP: the happy path", () => {
  it("POSTs a payment and reads it back by idempotency key", async () => {
    const { port } = await serve();

    const post = await call(port, "POST", "/payments", json(intentBody("http-1")));
    expect(post.status).toBe(200);
    expect(post.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post.body)).toMatchObject({
      idempotencyKey: "http-1",
      state: "completed",
    });

    const get = await call(port, "GET", "/payments/http-1");
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toMatchObject({
      idempotencyKey: "http-1",
      state: "completed",
    });
  });

  it("serves the public health endpoint without a body or a key", async () => {
    const { port } = await serve({ apiKeys: new Set(["sekret"]) });
    const res = await call(port, "GET", "/healthz");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });

  it("exposes /metrics as Prometheus text, not JSON, and unmetered", async () => {
    // capacity 0 would 429 anything metered, so this also proves the scrape
    // path stays open for a monitor that has no API key.
    const { port } = await serve({
      apiKeys: new Set(["sekret"]),
      rateLimit: { capacity: 0, refillPerSec: 0 },
      metricsText: () => "# TYPE corridor_transition counter\ncorridor_transition 3\n",
    });

    const res = await call(port, "GET", "/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/plain; version=0.0.4");
    // The string is written verbatim — a JSON-encoded scrape is not a scrape.
    expect(res.body).toBe("# TYPE corridor_transition counter\ncorridor_transition 3\n");
  });

  it("404s a path the router does not know", async () => {
    const { port } = await serve();
    const res = await call(port, "GET", "/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not found" });
  });
});

describe("service over HTTP: auth and tenancy", () => {
  it("401s a request with no key and accepts the right one", async () => {
    const { port } = await serve({ apiKeys: new Set(["sekret"]) });

    const anonymous = await call(port, "POST", "/payments", json(intentBody("http-nokey")));
    expect(anonymous.status).toBe(401);
    expect(JSON.parse(anonymous.body)).toEqual({ error: "unauthorized" });

    const keyed = await call(port, "POST", "/payments", {
      ...json(intentBody("http-keyed")),
      headers: { "content-type": "application/json", ...bearer("sekret") },
    });
    expect(keyed.status).toBe(200);
  });

  it("lowercases inbound header names before routing", async () => {
    // Node hands `incoming.headers` already lowercase, but the router is given a
    // `Record<string, string>` the transport builds — if that build ever keeps
    // the case, `bearer()` and the callback `signature` lookup stop matching and
    // auth silently turns off. Sending the header in mixed case makes that
    // regression a 401 here instead of a passing unit test.
    const { port } = await serve({ apiKeys: new Set(["sekret"]) });
    const res = await call(port, "POST", "/payments", {
      headers: { "Content-Type": "application/json", Authorization: "Bearer sekret" },
      body: JSON.stringify(intentBody("http-case")),
    });
    expect(res.status).toBe(200);
  });

  it("404s another tenant's run rather than confirming the key exists", async () => {
    const { port } = await serve({ apiKeys: new Set(["tenant-a", "tenant-b"]) });

    const created = await call(port, "POST", "/payments", {
      headers: { "content-type": "application/json", ...bearer("tenant-a") },
      body: JSON.stringify(intentBody("http-tenant")),
    });
    expect(created.status).toBe(200);

    expect(
      (await call(port, "GET", "/payments/http-tenant", { headers: bearer("tenant-a") }))
        .status,
    ).toBe(200);
    const intruder = await call(port, "GET", "/payments/http-tenant", {
      headers: bearer("tenant-b"),
    });
    expect(intruder.status).toBe(404);
    expect(JSON.parse(intruder.body)).toEqual({ error: "not found" });
  });
});

describe("service over HTTP: rate limiting and client identity", () => {
  it("429s once the bucket is drained", async () => {
    const { port } = await serve({ rateLimit: { capacity: 2, refillPerSec: 0 } });
    const hit = () => call(port, "GET", "/payments/absent");
    expect((await hit()).status).toBe(404);
    expect((await hit()).status).toBe(404);
    const drained = await hit();
    expect(drained.status).toBe(429);
    expect(JSON.parse(drained.body)).toEqual({ error: "rate_limited" });
  });

  it("ignores a forged X-Forwarded-For by default, so it cannot mint buckets", async () => {
    const { port } = await serve({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const hit = (xff: string) =>
      call(port, "GET", "/payments/absent", { headers: { "x-forwarded-for": xff } });

    expect((await hit("9.9.9.1")).status).toBe(404);
    // A different forged IP, but the same socket peer: still the same bucket.
    expect((await hit("9.9.9.2")).status).toBe(429);
  });

  it("honours X-Forwarded-For per client only under trustProxy", async () => {
    const { port } = await serve({
      rateLimit: { capacity: 1, refillPerSec: 0 },
      trustProxy: true,
    });
    const hit = (xff: string) =>
      call(port, "GET", "/payments/absent", { headers: { "x-forwarded-for": xff } });

    // Behind a trusted ingress the left-most entry is the identity, so each
    // client gets its own token …
    expect((await hit("9.9.9.1")).status).toBe(404);
    expect((await hit("9.9.9.2")).status).toBe(404);
    // … and returning under the same one is what drains.
    expect((await hit("9.9.9.1")).status).toBe(429);
  });
});

describe("service over HTTP: malformed input and unexpected failures", () => {
  it("400s a body that is not JSON", async () => {
    const { port } = await serve();
    const res = await call(port, "POST", "/payments", {
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "invalid JSON" });
  });

  it("500s when the store throws, and keeps serving on the next request", async () => {
    // A rejecting store escapes `route()` — the transport owns the only net that
    // stops it from either crashing the process or leaving the caller hanging on
    // a socket that will never be answered. GET is the honest path: it awaits the
    // store directly, so the rejection is the service's own and not the engine's
    // crash-retry handling layered on top.
    const broken: IdempotencyStore = {
      async get(): Promise<undefined> {
        throw new Error("connection terminated");
      },
      async put(): Promise<void> {
        throw new Error("connection terminated");
      },
      async create(): Promise<boolean> {
        throw new Error("connection terminated");
      },
      async listByState(): Promise<never[]> {
        throw new Error("connection terminated");
      },
      async getResolution(): Promise<undefined> {
        throw new Error("connection terminated");
      },
      async recordResolution(): Promise<boolean> {
        throw new Error("connection terminated");
      },
    };
    const { port } = await serve({ deps: deps({ idempotency: broken }) });

    const res = await call(port, "GET", "/payments/http-boom");
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "internal", message: "unexpected error" });

    // Same server, still listening: the failure was contained to that request.
    const healthy = await call(port, "GET", "/healthz");
    expect(healthy.status).toBe(200);
  });
});
