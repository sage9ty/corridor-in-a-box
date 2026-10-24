import {
  createMockAdapter,
  type MockAdapterOptions,
} from "@corridor/adapter-kit";
import {
  createMockSubmitter,
  defaultSep31Gate,
  execute,
  InMemoryAuditLog,
  InMemoryIdempotencyStore,
  type CorridorState,
  type EngineDeps,
} from "@corridor/engine";
import { getCorridor } from "./corridors";
import { parseCorridor } from "@corridor/manifest";
import { fail, ok, type PaymentIntent } from "@corridor/types";

export type PaymentScenario = "happy" | "quote-expired" | "settle-fails" | "reconcile-stall";

export interface EngineDemoResult {
  readonly ok: boolean;
  readonly state: CorridorState;
  readonly trail: readonly CorridorState[];
  readonly transactionId?: string;
  readonly stellarTxHash?: string;
  readonly idempotentReplay?: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

const MAX_IDEMPOTENCY_STORES = 500;
const idempotencyStores = new Map<string, InMemoryIdempotencyStore>();

function storeFor(key: string): InMemoryIdempotencyStore {
  const existing = idempotencyStores.get(key);
  if (existing) idempotencyStores.delete(key);

  const store = existing ?? new InMemoryIdempotencyStore();
  idempotencyStores.set(key, store);
  while (idempotencyStores.size > MAX_IDEMPOTENCY_STORES) {
    const oldest = idempotencyStores.keys().next();
    if (oldest.done) break;
    idempotencyStores.delete(oldest.value);
  }
  return store;
}

export async function runEngineDemoPayment(
  corridorId: string,
  amount: string,
  idempotencyKey: string,
  scenario: PaymentScenario,
): Promise<EngineDemoResult> {
  const source = getCorridor(corridorId);
  if (!source) {
    return {
      ok: false,
      state: "failed",
      trail: [],
      error: { code: "MANIFEST_INVALID", message: `unknown corridor ${corridorId}` },
    };
  }

  const parsed = parseCorridor(source);
  if (!parsed.ok) {
    return {
      ok: false,
      state: "failed",
      trail: [],
      error: { code: parsed.error.code, message: parsed.error.message },
    };
  }
  const corridor = parsed.value;

  const adapterOptions: MockAdapterOptions = {
    ...(scenario === "quote-expired" ? { expireQuoteImmediately: true } : {}),
    ...(scenario === "reconcile-stall" ? { settled: false } : {}),
    ...(corridor.fx.quote_source === "external" ? { capabilities: { quotes: ["native"] } } : {}),
  };
  const adapter = createMockAdapter(adapterOptions);
  const submitter = createMockSubmitter({
    failSubmit: scenario === "settle-fails",
    failRefund: scenario === "reconcile-stall",
  });
  const audit = new InMemoryAuditLog();
  const deps: EngineDeps = {
    resolver: {
      async resolve() {
        return { receiving: adapter, trust: "manifest" };
      },
    },
    submitter,
    gate: defaultSep31Gate(),
    idempotency: storeFor(idempotencyKey),
    audit,
    sleep: async () => {},
    trustManifestWithoutAttestation: true,
    ...(corridor.fx.quote_source === "external"
      ? {
          externalQuote: async () =>
            scenario === "quote-expired"
              ? fail("QUOTE_EXPIRED", "mock external quote configured to expire", {
                  retryable: true,
                })
              : ok({ price: "1.00" }),
        }
      : {}),
  };
  const intent: PaymentIntent = {
    idempotencyKey,
    corridorId: corridor.id,
    sender: { id: "demo-sender", jurisdiction: corridor.compliance.source_jurisdiction },
    recipient: { id: "demo-recipient", jurisdiction: corridor.compliance.dest_jurisdiction },
    sourceAmount: { asset: corridor.source.asset, amount },
  };

  const result = await execute(intent, corridor, deps);
  if (result.ok) {
    const replay = result.value.state === "completed" && result.value.trail.length === 1;
    return {
      ok: true,
      state: result.value.state,
      trail: result.value.trail,
      transactionId: result.value.transactionId,
      stellarTxHash: result.value.stellarTxHash,
      ...(replay ? { idempotentReplay: true } : {}),
    };
  }

  const transitions = audit.entries.map((entry) => entry.to);
  return {
    ok: false,
    state: transitions.at(-1) ?? "failed",
    trail: transitions.length ? ["created", ...transitions] : [],
    error: { code: result.error.code, message: result.error.message },
  };
}