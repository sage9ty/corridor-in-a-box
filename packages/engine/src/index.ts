// @corridor/engine — corridor-agnostic orchestration of the five verbs.

export {
  execute,
  type DryRunReport,
  type EngineDeps,
  type ExecuteOptions,
  type RunResult,
} from "./run";
export { ALL_STATES, canTransition, isTerminal, TERMINAL, type CorridorState } from "./state";
export {
  InMemoryIdempotencyStore,
  hasRequestedRefund,
  hasSettlementRef,
  type IdempotencyStore,
  type StoredRun,
  type ResolutionOutcome,
  type OutOfBandResolution,
  type ListRunsOptions,
} from "./idempotency";
export {
  PostgresIdempotencyStore,
  migrate,
  CREATE_TABLE_SQL,
  CREATE_RESOLUTIONS_TABLE_SQL,
  type Queryable,
  type QueryResult,
} from "./idempotency-pg";
export {
  BREAKER_METRICS,
  DEFAULT_BREAKER_THRESHOLD,
  InMemoryCorridorHealthStore,
  MeteredCorridorHealthStore,
  breakerOutcomeFor,
  justTripped,
  type BreakerOutcome,
  type BreakerRecord,
  type BreakerState,
  type CorridorHealthStore,
  type RecordOutcomeOptions,
} from "./breaker";
export { PostgresAuditSink, CREATE_AUDIT_TABLE_SQL } from "./audit-pg";
export {
  PostgresCorridorHealthStore,
  CREATE_BREAKERS_TABLE_SQL,
  BREAKERS_MIGRATION_SQL,
} from "./breaker-pg";
export {
  UnimplementedSubmitter,
  createMockSubmitter,
  StellarPaymentStrategy,
  AdapterSettledStrategy,
  defaultStrategies,
  needsPathPayment,
  settlementId,
  type SettlementSubmitter,
  type ChainVerifier,
  type SettlementRef,
  type SettlementRequest,
  type RefundRequest,
  type ReconcileWaker,
  InMemoryWaker,
  type SettlementStrategy,
  type SettlementStrategyContext,
  type DepositInstructionsKind,
} from "./ports";
export {
  quote,
  comply,
  open,
  settle,
  buildSettlementRequest,
  settleQuoteProblem,
  reconcile,
  reconcileUntil,
  watchRefund,
  anchorTerminalStatus,
  backoffMs,
  recover,
  type RecoveryAction,
  type PollOptions,
  type RefundPollOptions,
} from "./verbs";
export {
  CompositeGate,
  defaultSep31Gate,
  type DefaultSep31GateOptions,
  type GateContext,
  type CheckResult,
  type GateCheck,
  type PreSettleGate,
} from "./gate";
export {
  consoleLogger,
  silentLogger,
  childLogger,
  scopedAuditSink,
  InMemoryAuditLog,
  InMemoryAlerting,
  WebhookAlerting,
  noopAlerting,
  noopMetrics,
  InMemoryMetrics,
  PrometheusMetrics,
  type Logger,
  type LogLevel,
  type LogFields,
  type RequestScope,
  type AuditSink,
  type AuditEntry,
  type AuditDetail,
  type Alert,
  type AlertKind,
  type Alerting,
  type Metrics,
  type MetricTags,
} from "./observability";
export { quoteWindowCheck } from "./quoteWindow";
export {
  type QuoteProvider,
  AdapterQuoteProvider,
  Sep38QuoteProvider,
  ExternalQuoteProvider,
} from "@corridor/adapter-kit";
export { checkCompatibility } from "./compat";
