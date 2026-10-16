import { describe, expect, it } from "vitest";
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
} from "@corridor/engine";
import { createService, type ServiceOptions } from "@corridor/service";
import type { CorridorErrorCode, PaymentIntent } from "@corridor/types";

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
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

function intentBody(key = "p1"): PaymentIntent {
  return {
    idempotencyKey: key,
    corridorId: "test",
    sender: { id: "s" },
    recipient: { id: "r" },
    sourceAmount: { asset: "USDC", amount: "100.00" },
  };
}

function deps(adapterOpts = {}): EngineDeps {
  return {
    resolver: new StaticRouteResolver(() => createMockAdapter(adapterOpts), {
      trustManifestWithoutAttestation: true,
    }),
    submitter: createMockSubmitter(),
    idempotency: new InMemoryIdempotencyStore(),
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    unsafeSkipPreSettleGate: true,
  };
}

function svc(over: Partial<ServiceOptions> = {}) {
  return createService({
    corridors: new Map([["test", corridor()]]),
    deps: deps(),
    ...over,
  });
}

describe("service: POST /payments", () => {
  it("runs a payment and returns 200 completed", async () => {
    const s = svc();
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("completed");
  });

  it("returns 200 on idempotent replay of a completed key", async () => {
    const s = svc();
    await s.route({ method: "POST", path: "/payments", body: intentBody("dup") });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody("dup") });
    expect(r.status).toBe(200);
  });

  it("maps a malformed amount to 422", async () => {
    const s = svc();
    const body = { ...intentBody(), sourceAmount: { asset: "USDC", amount: "1,000" } };
    const r = await s.route({ method: "POST", path: "/payments", body });
    expect(r.status).toBe(422);
  });

  it("maps a KYC rejection to 403", async () => {
    const s = createService({
      corridors: new Map([["test", corridor()]]),
      deps: deps({ kyc: "rejected" }),
    });
    const r = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(r.status).toBe(403);
  });

  it("returns 404 for an unknown corridor", async () => {
    const s = svc();
    const r = await s.route({
      method: "POST",
      path: "/payments",
      body: { ...intentBody(), corridorId: "nope" },
    });
    expect(r.status).toBe(404);
  });

  it("returns 400 for a malformed body", async () => {
    const s = svc();
    const r = await s.route({ method: "POST", path: "/payments", body: { foo: "bar" } });
    expect(r.status).toBe(400);
  });
});

describe("service: GET /payments/:key", () => {
  it("returns the run state after a payment", async () => {
    const s = svc();
    await s.route({ method: "POST", path: "/payments", body: intentBody("look") });
    const r = await s.route({ method: "GET", path: "/payments/look" });
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("completed");
  });

  it("404s an unknown key", async () => {
    const r = await svc().route({ method: "GET", path: "/payments/missing" });
    expect(r.status).toBe(404);
  });
});

describe("service: body-size limit (HTTP server)", () => {
  async function listen(server: Server): Promise<{ port: number; close: () => void }> {
    server.listen(0);
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    return { port, close: () => server.close() };
  }

  function post(
    port: number,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "POST", path: "/payments", headers },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  it("rejects a body over the cap with 413 (declared Content-Length)", async () => {
    const { port, close } = await listen(svc({ maxBodyBytes: 64 }).server());
    try {
      const big = JSON.stringify({ blob: "x".repeat(500) });
      const res = await post(port, big, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(big)),
      });
      expect(res.status).toBe(413);
    } finally {
      close();
    }
  });

  it("rejects an oversized streamed body with 413 (no/short Content-Length)", async () => {
    const { port, close } = await listen(svc({ maxBodyBytes: 64 }).server());
    try {
      // Chunked transfer: the server can't trust a declared length and must cap
      // the bytes it actually buffers.
      const res = await post(port, JSON.stringify({ blob: "x".repeat(500) }), {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      });
      expect(res.status).toBe(413);
    } finally {
      close();
    }
  });

  it("still serves a normal payment under the cap", async () => {
    const { port, close } = await listen(svc().server());
    try {
      const res = await post(port, JSON.stringify(intentBody("http-ok")), {
        "content-type": "application/json",
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).state).toBe("completed");
    } finally {
      close();
    }
  });
});

describe("service: auth + rate limiting + health", () => {
  it("healthz is public", async () => {
    const r = await svc({ apiKeys: new Set(["secret"]) }).route({
      method: "GET",
      path: "/healthz",
    });
    expect(r.status).toBe(200);
  });

  it("serves /metrics as text when a renderer is configured, public + unmetered", async () => {
    const s = svc({
      apiKeys: new Set(["secret"]),
      rateLimit: { capacity: 0, refillPerSec: 0 }, // would 429 everything if metered
      metricsText: () => "# TYPE corridor_transition counter\ncorridor_transition 3\n",
    });
    const r = await s.route({ method: "GET", path: "/metrics" });
    expect(r.status).toBe(200);
    expect(r.contentType).toContain("text/plain");
    expect(r.body).toContain("corridor_transition 3");
  });

  it("404s /metrics when no renderer is configured", async () => {
    const r = await svc().route({ method: "GET", path: "/metrics" });
    expect(r.status).toBe(404);
  });

  it("rejects requests without a valid API key", async () => {
    const s = svc({ apiKeys: new Set(["secret"]) });
    const noKey = await s.route({ method: "POST", path: "/payments", body: intentBody() });
    expect(noKey.status).toBe(401);
    const good = await s.route({
      method: "POST",
      path: "/payments",
      body: intentBody(),
      headers: { authorization: "Bearer secret" },
    });
    expect(good.status).toBe(200);
  });

  it("rate-limits after the bucket is drained", async () => {
    let t = 0;
    const s = svc({ rateLimit: { capacity: 2, refillPerSec: 0 }, now: () => t });
    const hit = () =>
      s.route({
        method: "GET",
        path: "/payments/x",
        headers: { "x-forwarded-for": "1.1.1.1" },
      });
    expect((await hit()).status).toBe(404); // allowed (token 1)
    expect((await hit()).status).toBe(404); // allowed (token 2)
    expect((await hit()).status).toBe(429); // drained
    t += 100; // no refill configured
    expect((await hit()).status).toBe(429);
  });

  it("keys the rate limiter per resolved client IP", async () => {
    const s = svc({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const hit = (clientIp: string) =>
      s.route({ method: "GET", path: "/payments/x", clientIp });
    expect((await hit("10.0.0.1")).status).toBe(404); // client A's only token
    expect((await hit("10.0.0.1")).status).toBe(429); // A drained
    expect((await hit("10.0.0.2")).status).toBe(404); // B has its own bucket
  });

  it("does not let a forged X-Forwarded-For mint fresh buckets", async () => {
    // Without trustProxy the raw header is ignored for keying, so spoofing it
    // can't dodge the limit — all such requests share the 'anon' bucket.
    const s = svc({ rateLimit: { capacity: 1, refillPerSec: 0 } });
    const hit = (xff: string) =>
      s.route({ method: "GET", path: "/payments/x", headers: { "x-forwarded-for": xff } });
    expect((await hit("9.9.9.1")).status).toBe(404);
    expect((await hit("9.9.9.2")).status).toBe(429); // different forged IP, still limited
  });

  it("uses an injected (async, shared-style) limiter over the default", async () => {
    const seen: string[] = [];
    let allow = true;
    const s = svc({
      // The shape a Redis-backed limiter would have: async take().
      rateLimiter: {
        async take(key: string) {
          seen.push(key);
          return allow;
        },
      },
    });
    const hit = () => s.route({ method: "GET", path: "/payments/x", clientIp: "5.5.5.5" });
    expect((await hit()).status).toBe(404);
    allow = false;
    expect((await hit()).status).toBe(429);
    expect(seen).toEqual(["ip:5.5.5.5", "ip:5.5.5.5"]);
  });
});

describe("service documentation sync", () => {
  it("documents every CorridorErrorCode, HTTP status code, and GET /metrics in web docs", async () => {
    const { docs } = await import("../web/lib/docs.js");
    const httpApiDoc = docs.find((d) => d.slug === "http-api");
    expect(httpApiDoc).toBeDefined();
    const body = httpApiDoc!.body;

    const errorCodes: CorridorErrorCode[] = [
      "MANIFEST_INVALID",
      "AMOUNT_INVALID",
      "QUOTE_UNAVAILABLE",
      "QUOTE_EXPIRED",
      "KYC_REQUIRED",
      "KYC_REJECTED",
      "ANCHOR_UNAVAILABLE",
      "SETTLEMENT_FAILED",
      "SETTLEMENT_TIMEOUT",
      "REFUND_UNSUPPORTED",
      "RECONCILE_MISMATCH",
      "RECONCILE_STALLED",
      "IDEMPOTENCY_CONFLICT",
    ];

    for (const code of errorCodes) {
      expect(body).toContain(code);
    }

    const expectedStatuses = [
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
      "413",
      "422",
      "429",
      "500",
      "501",
      "502",
      "504",
    ];
    for (const status of expectedStatuses) {
      expect(body).toContain(`\`${status}\``);
    }

    expect(body).toContain("GET /metrics");
  });
});

import { CallbackVerifier } from "@corridor/service";
import { vi } from "vitest";
import { InMemoryWaker } from "@corridor/engine";

describe("service: POST /callbacks/sep31/:corridorId", () => {
  it("callback wakes a pending reconcile", async () => {
    const waker = new InMemoryWaker();
    const s = createService({
      corridors: new Map([["test", corridor()]]),
      deps: { ...deps(), waker },
    });

    const origFetch = global.fetch;
    const spy = vi.spyOn(CallbackVerifier.prototype, "verify").mockResolvedValue(true);
    global.fetch = (async () => ({
      ok: true,
      text: async () =>
        'SIGNING_KEY="GB5K2F7N7XZK22RKV4K7XZK22RKV4K7XZK22RKV4K7XZK22RKV4K7XZK22"',
    })) as unknown as typeof fetch;

    try {
      let woken = false;
      waker.signal("tx-123").addEventListener("abort", () => {
        woken = true;
      });

      const tStr = Math.floor(Date.now() / 1000).toString();
      const r = await s.route({
        method: "POST",
        path: "/callbacks/sep31/test",
        headers: { signature: `t=${tStr}, s=abc` },
        body: { transaction: { id: "tx-123" } },
        rawBody: '{"transaction":{"id":"tx-123"}}',
      });

      if (r.status !== 200) console.log(r);
      expect(r.status).toBe(200);
      expect(woken).toBe(true);
    } finally {
      global.fetch = origFetch;
      spy.mockRestore();
    }
  });

  it("unsigned callback 401", async () => {
    const s = createService({ corridors: new Map([["test", corridor()]]), deps: deps() });
    const r = await s.route({
      method: "POST",
      path: "/callbacks/sep31/test",
      body: { transaction: { id: "tx-123" } },
    });
    expect(r.status).toBe(401);
  });
});
