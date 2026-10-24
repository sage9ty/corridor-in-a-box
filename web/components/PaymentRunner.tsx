"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Play, RotateCcw, CircleCheck, CircleX, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { corridors, getCorridor, liveness, VERBS } from "@/lib/corridors";
import type { EngineDemoResult, PaymentScenario } from "@/lib/engine-demo";
import generatedStates from "@/lib/generated/states.json";
import { STEP_STATUS_TEXT, announceRun, stepStatus } from "@/lib/run-status";

type CorridorState = EngineDemoResult["state"];

// The engine's state list, generated from packages/engine/src/state.ts by
// `pnpm gen:web-data` rather than copied here.
const ALL_STATES = generatedStates.states as CorridorState[];

export function PaymentRunner({ initialCorridor }: { initialCorridor?: string }) {
  const [corridorId, setCorridorId] = useState(
    initialCorridor && getCorridor(initialCorridor) ? initialCorridor : corridors[0].id,
  );
  const [amount, setAmount] = useState("100.00");
  const [idemKey, setIdemKey] = useState("demo-0001");
  const [scenario, setScenario] = useState<PaymentScenario>("happy");
  const [running, setRunning] = useState(false);
  const [reached, setReached] = useState<CorridorState[]>([]);
  const [result, setResult] = useState<EngineDemoResult | null>(null);
  // The amount the last run was sent with, so the field is only marked invalid
  // while it still holds the value the engine refused.
  const [submittedAmount, setSubmittedAmount] = useState<string | null>(null);

  // Label, hint and error ids: a label with no `for` and a control with no id are
  // not associated, so a screen reader announces three unnamed fields.
  const uid = useId();
  const ids = {
    corridor: `${uid}-corridor`,
    scenario: `${uid}-scenario`,
    amount: `${uid}-amount`,
    amountUnit: `${uid}-amount-unit`,
    amountError: `${uid}-amount-error`,
    idemKey: `${uid}-idem-key`,
    idemHint: `${uid}-idem-hint`,
    heading: `${uid}-state-machine`,
  };
  const amountRef = useRef<HTMLInputElement>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    setReached([]);
    setSubmittedAmount(amount);

    // try/finally: without it, a network error or a non-JSON response threw out
    // of this function with `running` still true — spinner stuck forever, Run
    // button permanently disabled, only a page reload recovers.
    try {
      const res = await fetch("/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          corridorId,
          idempotencyKey: idemKey,
          sender: { id: "sender-1" },
          recipient: { id: "recipient-1" },
          sourceAmount: { asset: "USDC", amount },
          scenario,
        }),
      });

      let outcome: EngineDemoResult;
      try {
        outcome = (await res.json()) as EngineDemoResult;
      } catch {
        throw new Error(`server returned ${res.status} with a non-JSON body`);
      }
      if (!outcome?.trail) {
        const message =
          (outcome as unknown as { message?: string; error?: string })?.message ??
          (outcome as unknown as { error?: string })?.error ??
          `request failed (HTTP ${res.status})`;
        throw new Error(message);
      }

      // Animate the trail one state at a time.
      for (const state of outcome.trail) {
        setReached((prev) => [...prev, state]);
        await new Promise((r) => setTimeout(r, outcome.idempotentReplay ? 60 : 260));
      }
      setResult(outcome);
    } catch (e) {
      setResult({
        ok: false,
        state: "failed",
        trail: [],
        error: {
          code: "REQUEST_FAILED",
          message: e instanceof Error ? e.message : "could not reach the API",
        },
      });
    } finally {
      setRunning(false);
    }
  }

  function reset() {
    setResult(null);
    setReached([]);
    setSubmittedAmount(null);
  }

  const corridor = getCorridor(corridorId)!;
  const live = liveness(corridor);

  // The engine's own refusal of the amount is the one validation error this form
  // produces; tie it to the field it is about instead of leaving it in the result.
  const amountInvalid = result?.error?.code === "AMOUNT_INVALID" && amount === submittedAmount;

  // A refused amount is fixed in the field, so put the cursor there rather than
  // leave it on the button that was just pressed.
  useEffect(() => {
    if (result?.error?.code === "AMOUNT_INVALID") amountRef.current?.focus();
  }, [result]);

  return (
    <div className="grid gap-6 md:grid-cols-[340px_1fr]">
      {/* Controls */}
      <Card className="flex flex-col gap-4 self-start">
        <div>
          <label htmlFor={ids.corridor} className="mb-1 block text-sm font-medium">
            Corridor
          </label>
          <select
            id={ids.corridor}
            value={corridorId}
            onChange={(e) => setCorridorId(e.target.value)}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            {corridors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} ({c.fx.path.join(" → ")})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={ids.amount} className="mb-1 block text-sm font-medium">
            Source amount
          </label>
          <div className="flex items-center gap-2">
            <input
              id={ids.amount}
              ref={amountRef}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={amountInvalid || undefined}
              aria-describedby={amountInvalid ? `${ids.amountUnit} ${ids.amountError}` : ids.amountUnit}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
            />
            <span id={ids.amountUnit} className="text-sm text-secondary-text">
              {corridor.source.asset}
            </span>
          </div>
          {amountInvalid && (
            <p id={ids.amountError} className="mt-1 text-xs text-red-700 dark:text-red-400">
              {result?.error?.message}
            </p>
          )}
        </div>

        <div>
          <label htmlFor={ids.scenario} className="mb-1 block text-sm font-medium">
            Scenario
          </label>
          <select
            id={ids.scenario}
            value={scenario}
            onChange={(e) => {
              const nextScenario = e.target.value as PaymentScenario;
              setScenario(nextScenario);
              setIdemKey(`demo-${nextScenario}-${crypto.randomUUID()}`);
            }}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          >
            <option value="happy">Happy path</option>
            <option value="quote-expired">Quote expired</option>
            <option value="settle-fails">Settlement retries then fails</option>
            <option value="reconcile-stall">Reconciliation stalls and holds</option>
          </select>
        </div>

        <div>
          <label htmlFor={ids.idemKey} className="mb-1 block text-sm font-medium">
            Idempotency key
          </label>
          <input
            id={ids.idemKey}
            value={idemKey}
            onChange={(e) => setIdemKey(e.target.value)}
            autoComplete="off"
            aria-describedby={ids.idemHint}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm"
          />
          <p id={ids.idemHint} className="mt-1 text-xs text-secondary-text">
            Re-run with the same key to see the idempotent replay.
          </p>
        </div>

        {/* Mock adapters exercise the real engine without using live endpoints or funds. */}
        <div className="rounded-lg border border-border bg-bg-subtle px-3 py-2 text-xs text-secondary-text">
          <span className="font-medium">
            {live.state === "proven"
              ? "A canary payment completed on this lane."
              : live.state === "verified"
                ? `Endpoints verified ${live.verifiedAt}.`
                : live.state === "unverified"
                  ? "Endpoints UNVERIFIED."
                  : "Corridor NOT RUNNABLE."}
          </span>{" "}
          {live.state === "proven" || live.state === "verified"
            ? "The real engine runs with mock anchor and settlement adapters; no funds move."
            : "The real engine runs with mock adapters, not live anchor endpoints or funds."}
        </div>

        <div className="flex gap-2">
          <Button onClick={run} disabled={running} className="flex-1">
            {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
            {running ? "Running…" : "Run payment"}
          </Button>
          <Button variant="secondary" onClick={reset} disabled={running}>
            <RotateCcw size={16} />
            <span className="sr-only">Reset</span>
          </Button>
        </div>
      </Card>

      {/* Trail */}
      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 id={ids.heading} className="font-semibold">
            State machine
          </h2>
          {result && (
            <Badge variant={result.ok ? "success" : "danger"}>
              {result.ok ? <CircleCheck size={12} /> : <CircleX size={12} />}
              {result.state}
              {result.idempotentReplay ? " · idempotent replay" : ""}
            </Badge>
          )}
        </div>

        {/* One announcement per run. The region is always in the page, because a
            live region only speaks about changes to something already there; it
            says "running" while the trail animates (so its steps are not read out
            one by one) and the outcome once it is known. */}
        <output aria-live="polite" aria-atomic="true" className="sr-only">
          {announceRun(running, result, reached)}
        </output>

        <ol aria-labelledby={ids.heading} className="flex flex-col gap-1.5">
          {ALL_STATES.map((state) => {
            const status = stepStatus(state, reached, result);
            const isReached = status === "reached";
            const isFailedHere = status === "failed";
            const verb = VERBS.find((v) =>
              state === "quoted" ? v.verb === "quote"
              : state === "compliant" ? v.verb === "comply"
              : state === "opened" ? v.verb === "open"
              : state === "settled" ? v.verb === "settle"
              : state === "reconciled" ? v.verb === "reconcile"
              : false,
            );
            return (
              <li
                key={state}
                className={
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors " +
                  (isFailedHere
                    ? "bg-red-50 dark:bg-red-900/20"
                    : isReached
                      ? "bg-bg-subtle"
                      : "text-secondary-text")
                }
              >
                {/* The glyph is for sighted users; the status is spoken below,
                    so neither colour nor the glyph carries it alone. */}
                <span
                  aria-hidden="true"
                  className={
                    "flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold " +
                    (isFailedHere
                      ? "bg-red-600 text-white"
                      : isReached
                        ? "bg-blue-600 text-white"
                        : "border border-border text-secondary-text")
                  }
                >
                  {isFailedHere ? "!" : isReached ? "✓" : ""}
                </span>
                <span className="font-mono font-medium">{state}</span>
                <span className="sr-only">: {STEP_STATUS_TEXT[status]}</span>
                {/* On the red failed row the grey secondary text is 4.41:1, just under
                    the 4.5:1 minimum, so that one row uses the primary colour. */}
                {verb && (
                  <span
                    className={
                      "text-xs " + (isFailedHere ? "text-primary-text" : "text-secondary-text")
                    }
                  >
                    {verb.sep}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {result && !result.ok && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-300">
            <span className="font-mono font-semibold">{result.error?.code}</span> —{" "}
            {result.error?.message}
          </div>
        )}
        {result?.ok && result.stellarTxHash && (
          <div className="rounded-lg bg-bg-subtle px-3 py-2 text-xs">
            <span className="text-secondary-text">stellar tx: </span>
            <span className="font-mono break-all">{result.stellarTxHash}</span>
          </div>
        )}
      </Card>
    </div>
  );
}
