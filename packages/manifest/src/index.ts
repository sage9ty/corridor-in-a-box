// @corridor/manifest — the corridor abstraction made physical.
//
// THIS is where the multi-corridor design lives. A corridor is a validated data
// object, never code. Adding Mexico or Argentina or (one day) China is a new YAML
// file that parses to this schema — not a fork of the engine.
//
// Keep this schema deliberately THIN. Do not add a field until a second real
// corridor proves you need it; over-specifying here is the same premature
// generalization trap, just relocated into Zod.

import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  ok,
  fail,
  type Ok,
  type Err,
  type CorridorError,
  compareAmounts,
} from "@corridor/types";

/** SEP endpoints an anchor exposes. Only home_domain is mandatory; the rest are
 *  discovered from its stellar.toml in practice, but may be pinned here. */
export const AnchorEndpointsSchema = z.object({
  home_domain: z.string().min(1),
  /** SEP-31 DIRECT_PAYMENT_SERVER */
  transfer_server_sep31: z.string().url().optional(),
  /** SEP-10 WEB_AUTH_ENDPOINT */
  web_auth: z.string().url().optional(),
  /** SEP-12 KYC_SERVER */
  kyc_server: z.string().url().optional(),
  /** SEP-38 QUOTE_SERVER */
  quote_server: z.string().url().optional(),
  /**
   * ISO date (YYYY-MM-DD) on which the URLs above were confirmed against this
   * anchor's PUBLISHED stellar.toml, or — for a self-hosted lane like the Anchor
   * Platform reference server — against a running instance.
   *
   * Presence of a URL proves nothing: a manifest can name an endpoint that has
   * never existed. This field is the difference between "someone typed a URL"
   * and "someone checked it", and it is what `liveness()` requires before it
   * will report a corridor as verified. Leave it unset until you have actually
   * looked. Never set it speculatively.
   */
  endpoints_verified_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expected an ISO date, YYYY-MM-DD")
    .optional(),
});

const AnchorBaseSchema = z.object({
  name: z.string().min(1),
  /** Asset this anchor deals in at this leg. Source side: typically "USDC".
   *  Dest side: the off-chain payout asset, e.g. "iso4217:ARS". */
  asset: z.string().min(1),
});

export const AnchorSchema = AnchorBaseSchema.extend({ endpoints: AnchorEndpointsSchema });

// `transfer_server_sep31` stays optional so an incomplete manifest still
// parses; `liveness()` reports a SEP-31 dest without it as NOT runnable.
const Sep31DestSchema = AnchorBaseSchema.extend({
  protocol: z.literal("sep31").default("sep31"),
  endpoints: AnchorEndpointsSchema,
});

const Sep6DestSchema = AnchorBaseSchema.extend({
  protocol: z.literal("sep6"),
  endpoints: z.object({
    home_domain: z.string().min(1),
    transfer_server: z.string().url(),
    web_auth: z.string().url().optional(),
    kyc_server: z.string().url().optional(),
    quote_server: z.string().url().optional(),
    endpoints_verified_at: AnchorEndpointsSchema.shape.endpoints_verified_at,
  }),
});

const CustomDestSchema = AnchorBaseSchema.extend({
  protocol: z.string().regex(/^custom:[a-z0-9-]+$/, "expected custom:<lowercase-id>"),
  endpoints: z.object({
    home_domain: z.string().min(1),
    base_url: z.string().url(),
    extra: z.record(z.string(), z.string()).default({}),
    endpoints_verified_at: AnchorEndpointsSchema.shape.endpoints_verified_at,
  }),
});

// A discriminated union discriminates before defaults apply, so default an
// absent `protocol` to "sep31" first (existing manifests unchanged), the same
// way SourceAnchorSchema defaults to "prefunded".
export const DestSchema = z.preprocess(
  (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw) && !("protocol" in raw)
      ? { ...raw, protocol: "sep31" }
      : raw,
  z.discriminatedUnion("protocol", [Sep31DestSchema, Sep6DestSchema]).or(CustomDestSchema),
);

/**
 * How the SENDING side is reached. Schema only: the engine does not act on this
 * yet (the source-anchor adapter and fund step come later), it only lets a
 * manifest say whether the operator already holds the bridge asset or on-ramps
 * through an anchor deposit.
 *
 *  - `prefunded` (default when `protocol` is absent): the operator's own
 *    treasury. Needs only `name` / `asset`; `endpoints` is optional.
 *  - `sep6`: SEP-6 deposit; requires `endpoints.transfer_server`.
 *  - `sep24`: SEP-24 interactive deposit; requires
 *    `endpoints.transfer_server_sep24` and `endpoints.web_auth`.
 *  - `custom:<id>`: bespoke integration; requires `endpoints.base_url`.
 */
const SourceBase = { name: z.string().min(1), asset: z.string().min(1) };
const SourceEndpointsBase = AnchorEndpointsSchema.partial({ home_domain: true });

export const PrefundedSourceSchema = z.object({
  ...SourceBase,
  protocol: z.literal("prefunded"),
  endpoints: SourceEndpointsBase.optional(),
});
export const Sep6SourceSchema = z.object({
  ...SourceBase,
  protocol: z.literal("sep6"),
  endpoints: AnchorEndpointsSchema.extend({ transfer_server: z.string().url() }),
});
export const Sep24SourceSchema = z.object({
  ...SourceBase,
  protocol: z.literal("sep24"),
  endpoints: AnchorEndpointsSchema.extend({
    transfer_server_sep24: z.string().url(),
    web_auth: z.string().url(),
  }),
});
export const CustomSourceSchema = z.object({
  ...SourceBase,
  protocol: z
    .string()
    .regex(/^custom:[A-Za-z0-9_.-]+$/, "expected prefunded, sep6, sep24 or custom:<id>"),
  endpoints: AnchorEndpointsSchema.extend({ base_url: z.string().url() }),
});

export const SourceAnchorSchema = z.preprocess(
  (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw) && !("protocol" in raw)
      ? { ...raw, protocol: "prefunded" }
      : raw,
  z.union([PrefundedSourceSchema, Sep6SourceSchema, Sep24SourceSchema, CustomSourceSchema]),
);

export const FxSchema = z
  .object({
    /** The conversion path, in order. e.g. ["NGN","USDC","ARS"]. >= 2 hops. */
    path: z.array(z.string().min(1)).min(2),
    quote_source: z.enum(["sep38", "external"]).default("sep38"),
    /** Who carries the rate risk between quote-time and settlement. */
    who_holds_risk: z.enum(["sender", "sending_anchor", "receiving_anchor"]),
    /** Firm-quote TTL. The settle leg must hit the chain before this elapses. */
    quote_ttl_seconds: z.number().int().positive().default(60),
    /**
     * Minimum seconds a firm quote must still have left when a settle attempt
     * starts (#152). Covers submit plus Horizon confirmation, so a quote that
     * is technically alive but would expire mid-flight is refused BEFORE our
     * money moves, instead of the anchor rejecting or re-pricing the payout
     * after it has. Enforced by the `quote.window` gate check.
     */
    min_quote_remaining_seconds: z.number().int().positive().default(45),
  })
  .superRefine((fx, ctx) => {
    // A margin at or above the TTL would refuse every firm quote the moment
    // it is minted — a corridor that can never settle, misconfigured rather
    // than cautious.
    if (fx.min_quote_remaining_seconds >= fx.quote_ttl_seconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["min_quote_remaining_seconds"],
        message: `min_quote_remaining_seconds (${fx.min_quote_remaining_seconds}) must be smaller than quote_ttl_seconds (${fx.quote_ttl_seconds})`,
      });
    }
  });

export const ComplianceSchema = z.object({
  source_jurisdiction: z.string().min(1),
  dest_jurisdiction: z.string().min(1),
  travel_rule_profile: z.string().default("default"),
  /**
   * SEP-12 customer `type` for the receiving party.
   *
   * This is NOT free-form and cannot be synthesised from a jurisdiction: it must
   * be one of the types the destination anchor advertises under
   * `sep12.receiver.types` in its `GET /sep31/info` response. Send a type the
   * anchor doesn't publish and registration is rejected. `sep31-receiver` is the
   * conventional name and what the Anchor Platform reference server uses; check
   * /info for anything else.
   */
  sep12_receiver_type: z.string().default("sep31-receiver"),
  /** SEP-12 customer `type` for the sending party, from `sep12.sender.types`. */
  sep12_sender_type: z.string().default("sep31-sender"),
});

export const SettlementSchema = z.object({
  /** The on-chain bridge asset moved between the two anchors. */
  bridge_asset: z.string().default("USDC"),
  network: z.enum(["public", "testnet"]),
  /** Issuer account of the bridge asset on the chosen network. */
  asset_issuer: z.string().min(1),
});

/** Per-corridor payment limits (floor and ceiling). Optional, but a lane with no ceiling accepts
 *  any positive amount the caller asks for — set one before real money. */
export const LimitsSchema = z
  .object({
    /** Smallest single payment this corridor will accept, as a decimal string in
     *  the source asset. Omit for no floor. */
    min_amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount")
      .optional(),
    /** Largest single payment this corridor will accept, as a decimal string in
     *  the source asset. Omit for no ceiling (dev/testnet only). */
    max_amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount")
      .optional(),
  })
  .superRefine((val, ctx) => {
    if (val.min_amount !== undefined && val.max_amount !== undefined) {
      const cmp = compareAmounts(val.min_amount, val.max_amount);
      if (cmp.ok && cmp.value === 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `min_amount (${val.min_amount}) must be <= max_amount (${val.max_amount})`,
          path: ["min_amount"],
        });
      }
    }
  });

/** How patiently this corridor polls the receiving anchor after settling. Both
 *  fields are optional: an unset field falls back to `EngineDeps`, then to the
 *  engine default (2s poll, stall after 10 identical polls). */
export const ReconcileSchema = z.object({
  /** Seconds between reconcile polls. */
  poll_seconds: z.number().int().positive().optional(),
  /** Consecutive identical-status polls before `RECONCILE_STALLED`. 0 disables. */
  stall_polls: z.number().int().nonnegative().optional(),
  /** Seconds a pending_external/pending_receiver status may stay unchanged before it counts as stalled. */
  external_stall_seconds: z.number().int().positive().default(21_600),
});

export const BreakerSchema = z.object({
  /**
   * Consecutive lane-level failures after which the corridor halts.
   *
   * This is a *lane* circuit breaker, not a per-payment one: it counts whole
   * runs that failed for settlement/reconcile reasons (see
   * `breakerOutcomeFor` in @corridor/engine) and ignores failures that never
   * got the money moving, so a bad quote or a rejected KYC cannot take a lane
   * down. A successful run clears the count.
   *
   * Once it trips, new runs are refused with `CORRIDOR_HALTED` until a human
   * resets it (`corridor breaker reset <id> --reason "…"`). There is no
   * automatic half-open: the whole point is that reopening is a decision, not
   * a timeout.
   */
  consecutive_failures: z.number().int().positive().default(3),
});

export const RecoverySchema = z.object({
  max_retries: z.number().int().nonnegative().default(3),
  timeout_seconds: z.number().int().positive().default(900),
  /** How long to wait for an anchor-driven refund report after a terminal failure. */
  refund_wait_seconds: z.number().int().positive().default(86_400),
  rollback: z.enum(["refund_sender", "hold", "manual"]).default("refund_sender"),
  reconcile: ReconcileSchema.default(() => ReconcileSchema.parse({})),
  /** Omit the whole block to take the defaults (halt after 3 consecutive failures). */
  breaker: BreakerSchema.default(() => BreakerSchema.parse({})),
});

/** True when the YYYY-MM-DD part names a real calendar day. `Date` alone is no help:
 *  it rolls 2026-02-30 over to 2 March instead of rejecting it. */
function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
  );
}

/** Canary payment evidence proving this exact lane successfully moved money. */
export const ProofSchema = z.object({
  /** ISO date or timestamp on which the canary payment reached completed. */
  canary_completed_at: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/,
      "expected an ISO date (YYYY-MM-DD) or timestamp",
    )
    .refine(isRealCalendarDate, "not a real calendar date"),
  /** 64-hex Stellar transaction hash for the on-chain settlement leg. */
  stellar_tx_hash: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "expected a 64-character hex transaction hash"),
  /** Destination anchor's external transaction / order ID. */
  anchor_transaction_id: z.string().min(1),
  /** Amount delivered or transferred in the canary payment, as a decimal string. */
  amount: z.string().regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount"),
  /** Max validity age of the proof in days before becoming stale. Default 30. */
  max_age_days: z.number().int().positive().default(30),
  /** Optional canary max amount ceiling. */
  canary_max_amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "expected a positive decimal amount")
    .optional(),
});

export const CorridorSchema = z.object({
  id: z.string().min(1),
  /** Human note. Use it to record liveness, e.g. "pending: no RMB SEP-31 anchor". */
  status_note: z.string().optional(),
  source: SourceAnchorSchema,
  dest: DestSchema,
  fx: FxSchema,
  compliance: ComplianceSchema,
  settlement: SettlementSchema,
  recovery: RecoverySchema,
  limits: LimitsSchema.optional(),
  proof: ProofSchema.optional(),
});

export type Corridor = z.infer<typeof CorridorSchema>;
export type DestProtocol = "sep31" | "sep6" | `custom:${string}`;
export type Sep31Anchor = z.infer<typeof Sep31DestSchema>;
export type Sep6Anchor = z.infer<typeof Sep6DestSchema>;
export type CustomAnchor = z.infer<typeof CustomDestSchema>;
export type AnchorConfig = Sep31Anchor | Sep6Anchor | CustomAnchor;

export function protocolOf(anchor: z.infer<typeof DestSchema>): DestProtocol {
  return anchor.protocol as DestProtocol;
}
export type SourceAnchorConfig = z.infer<typeof SourceAnchorSchema>;
export type Proof = z.infer<typeof ProofSchema>;

/** Successful parse, plus non-fatal warnings (e.g. deprecated legacy shapes).
 *  Assignable to `Outcome<Corridor>`, so existing callers are unaffected. */
export type ParseCorridorOutcome =
  (Ok<Corridor> & { readonly warnings: string[] }) | Err<CorridorError>;

/** Parse + validate a corridor manifest from an object already in memory. */
export function parseCorridor(raw: unknown): ParseCorridorOutcome {
  const warnings: string[] = [];
  const dest =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).dest : undefined;
  if (dest && typeof dest === "object" && !Array.isArray(dest) && !("protocol" in dest)) {
    // Legacy flat SEP-31 manifest: no `protocol`. Parsed as sep31 for backward
    // compatibility, but a key belonging to another protocol is ambiguous.
    const ep = (dest as Record<string, unknown>).endpoints;
    const keys = ep && typeof ep === "object" ? ep : {};
    if ("transfer_server" in keys) {
      return fail(
        "MANIFEST_INVALID",
        "dest.protocol: manifest dest specifies transfer_server with no protocol; set protocol: sep6",
      );
    }
    if ("base_url" in keys) {
      return fail(
        "MANIFEST_INVALID",
        "dest.protocol: manifest dest specifies base_url with no protocol; set protocol: custom:<name>",
      );
    }
    warnings.push(
      "dest anchor specifies no protocol; defaulting to 'sep31'. " +
        "Set dest.protocol: 'sep31' explicitly; omitting it is deprecated.",
    );
  }
  const parsed = CorridorSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("MANIFEST_INVALID", formatZodError(parsed.error), { cause: parsed.error });
  }
  return { ...ok(parsed.data), warnings };
}

/** Read + validate a *.corridor.yaml file from disk. */
export function loadCorridor(path: string): ParseCorridorOutcome {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (cause) {
    return fail("MANIFEST_INVALID", `cannot read or parse ${path}`, { cause });
  }
  return parseCorridor(raw);
}

function formatZodError(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

// Liveness lives beside the schema because it is a statement ABOUT a manifest:
// whether the lane it describes can actually settle, and whether anyone has
// checked. Both the CLI and the web dashboard read it, so neither can report a
// corridor as healthy on its own authority.
export { liveness, LIVENESS_LABEL, type Liveness, type LivenessState } from "./liveness";
