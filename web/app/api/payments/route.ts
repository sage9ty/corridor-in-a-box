import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runEngineDemoPayment, type PaymentScenario } from "@/lib/engine-demo";

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// POST /api/payments — mirrors @corridor/service's POST /payments.
//
// Two modes:
//   default            run the real engine with in-memory mock adapters so the
//                      showcase works with zero backend and moves no real funds.
//   CORRIDOR_SERVICE_URL set
//                      PROXY to a real @corridor/service instance.
//
// The proxy path is gated. It previously forwarded any anonymous caller's body
// to the internal service AND attached the server's API key — which turns a
// key-protected payments API into an open one for anyone who can reach this
// route. A public endpoint must not lend out its credentials, so proxying now
// requires the caller to present CORRIDOR_WEB_API_KEY.

/** A payment intent is well under 1 KiB; anything larger is not a real request. */
const MAX_BODY_BYTES = 16 * 1024;

export async function POST(req: Request) {
  // Reject oversized bodies before parsing. Without this the route accepted
  // multi-megabyte payloads and handed the attacker-controlled idempotencyKey
  // straight to a process-lifetime Map.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid payment body" }, { status: 400 });
  }

  const b = body as {
    corridorId?: string;
    sourceAmount?: { amount?: string };
    idempotencyKey?: string;
    scenario?: unknown;
  };
  if (
    typeof b.corridorId !== "string" ||
    typeof b.sourceAmount?.amount !== "string" ||
    !b.sourceAmount.amount ||
    typeof b.idempotencyKey !== "string" ||
    !b.idempotencyKey
  ) {
    return NextResponse.json({ error: "invalid payment body" }, { status: 400 });
  }
  // Bound caller-controlled IDs before they enter the process-local demo store.
  if (b.idempotencyKey.length > 128 || b.corridorId.length > 128) {
    return NextResponse.json({ error: "invalid payment body" }, { status: 400 });
  }

  const serviceUrl = process.env.CORRIDOR_SERVICE_URL;
  if (serviceUrl) {
    const required = process.env.CORRIDOR_WEB_API_KEY;
    if (!required) {
      // Fail closed. Proxying to a real engine without a gate in front of it is
      // never the behaviour we want to fall back into by omission.
      return NextResponse.json(
        {
          error: "proxy_misconfigured",
          message: "CORRIDOR_SERVICE_URL is set but CORRIDOR_WEB_API_KEY is not",
        },
        { status: 503 },
      );
    }
    const presented = req.headers.get("authorization");
    if (!presented || !constantTimeEqual(presented, `Bearer ${required}`)) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const proxyBody = { ...(body as Record<string, unknown>) };
    delete proxyBody.scenario;
    return proxyToService(serviceUrl, proxyBody);
  }

  const scenario = b.scenario ?? "happy";
  if (
    scenario !== "happy" &&
    scenario !== "quote-expired" &&
    scenario !== "settle-fails" &&
    scenario !== "reconcile-stall"
  ) {
    return NextResponse.json({ error: "invalid payment scenario" }, { status: 400 });
  }

  const result = await runEngineDemoPayment(
    b.corridorId,
    b.sourceAmount.amount,
    b.idempotencyKey,
    scenario as PaymentScenario,
  );
  return NextResponse.json(result, { status: 200 });
}

/** Forward the payment to a real @corridor/service POST /payments and relay its response. */
async function proxyToService(serviceUrl: string, body: unknown) {
  const apiKey = process.env.CORRIDOR_SERVICE_API_KEY;
  try {
    const res = await fetch(`${serviceUrl.replace(/\/$/, "")}/payments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json(
      { error: "service_unreachable", message: "could not reach CORRIDOR_SERVICE_URL" },
      { status: 502 },
    );
  }
}
