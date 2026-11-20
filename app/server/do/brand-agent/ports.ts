// The BrandAgent's ports (p3-design section 12): what it calls out to (the runner pool, the usage ledger, the file
// ledger), each built in compose.ts by its owner, and the RPC surface other parts of the Worker call it through
// (`BrandAgentRpc`: the egress, the API handlers, the Runner objects, the health signals). W1's first PR defines them
// with a fake of each under testing/; W2, W3 and W4 fill the real pool, files and usage ports. Every amount is in
// micro-USD, every time in epoch ms.
import type { AuditEntry, OutputFormat, PushAck, RunEvent, RunStart } from '../../../shared/protocol/index.ts'
import type { AgentErrorCode, ErrorReason } from '../../../shared/contract/common.ts'
import type { Trace } from '../../../shared/contract/trace.ts'
import type { ActiveRun, PauseState, SendTurnInput, SendTurnResult } from '../../../shared/contract/runs.ts'
import type { Effort } from '../../../shared/contract/common.ts'
import type { SignalResult } from '../../ops/signals/types.ts'
import type { EgressRoute, RunGrant, TokenRefusal } from './tokens.ts'
import type { Scheduler } from './scheduler.ts'

/** A refusal the API answers with its code and reason (P2's error body). */
export type Refusal = { refused: { code: AgentErrorCode; reason?: ErrorReason } }

// ---------- the runner pool (W2, p3-design section 7) ----------

/** The answer of one runner's `GET /runs/:id`, or `unreachable` when the runner didn't answer. */
export type RunnerTurnStatus = 'live' | 'ended' | 'unknown' | 'unreachable'

/**
 * What the pool calls back on the BrandAgent (W2 fit point 3). The pool's queue rows never hold a run token.
 * - `retryPlacement(turnId)`: a queued turn may try again: the BrandAgent revokes that attempt's token, mints a new one
 *   and calls `place` again.
 * - `placementExpired(turnId)`: the turn waited 60 s in the placement queue: the BrandAgent fails it `pool_full`.
 */
export interface PlacementHooks {
  retryPlacement(turnId: string): void | Promise<void>
  placementExpired(turnId: string): void | Promise<void>
}

/** The BrandAgent's parts the pool runs on (W2 fit point 1): its SQLite (`pool_*`, live counts from `turns`), scheduler and clock. */
export interface BrandAgentParts {
  sql: SqlStorage
  scheduler: Scheduler
  now: () => number
  hooks: PlacementHooks
}

/** The pool's health signals (section 7): `pool_protocol`, `pool_restarts`, `pool_shortfall`. Counts only. */
export interface PoolHealth {
  protocol: SignalResult
  restarts: SignalResult
  shortfall: SignalResult
}

export interface RunnerPoolPort {
  /**
   * Place a turn (`rs.runId` is the turn id) on a runner. `admitted`: the runner's name; `queued`: in the placement
   * queue (the turn stays `starting`, inside its 3-minute deadline, until a hook calls back); a definite refusal;
   * `ambiguous`: the request may have reached the runner named (never try another). `rejected`: the runner refused the
   * RunStart itself with a typed 4xx (400, 413): the BrandAgent fails the turn `protocol` (no other runner would take it).
   * `gen` is the turn's generation at the claim, so an answer for an older attempt can be told apart.
   */
  place(rs: RunStart, gen: number): Promise<
    | { admitted: string } | { queued: true } | { refused: 'pool_full' | 'files' | 'draining' } | { refused: 'rejected'; status: number }
    | { ambiguous: string }
  >
  interrupt(runner: string, turnId: string): Promise<void>
  stop(runner: string, turnId: string): Promise<void>
  /** `containerGone`: the runner's container generation is gone or not running (design 1.3's second condition). */
  status(runner: string, turnId: string): Promise<{ state: RunnerTurnStatus; containerGone: boolean }>
  /** The turn released its runner (the next placement may use the slot). */
  turnEnded(runner: string, turnId: string): void
  health(): PoolHealth
  /**
   * Route 46 (W2 fit point 4): writes `draining_since_ms` and `draining_until_ms` in `flags` synchronously. The flags
   * can outlive the drain's expiry, so a reader (the pool, the BrandAgent's admission) counts a drain only while
   * `draining_until_ms > now`, never from the flag being present.
   */
  drain(nowMs: number): DrainState
  /** Route 47. */
  drainState(): DrainState
  /** Route 48: start runners, check them, clear the drain. */
  warmup(): Promise<{ ok: true } | Refusal>
  /** A container exited: the turn ids the BrandAgent fences, or null when this generation was already reported. */
  containerExited(runner: string, gen: number): string[] | null
  /** The `pool-retry` task's work (its handler only gets `ctx.ports.pool`): try the placement queue again. */
  retryQueue(): Promise<void>
  /** Takes a turn out of the placement queue (the BrandAgent cancelled it); nothing when it isn't queued. */
  dequeue(turnId: string): void
  /** Empties the placement queue and returns the turn ids it held, in queue order (pause fails them `paused`, 4.11). */
  clearQueue(): string[]
}

// ---------- the usage ledger (W4, p3-design section 9) ----------

export interface ReserveInput {
  turnId: string
  runId: string
  chatId: string
  memberId: string
  /** The turn model's API id (its per-turn ceiling). */
  model: string
  nowMs: number
}

export interface UsageLedgerPort {
  /** The turn's start hold, idempotent by turn id. */
  reserve(t: ReserveInput): Promise<{ reservedMicro: number } | { refused: 'cap_reached' | 'budget_busy' }>
  /** Raise the turn's hold before admitting a call, idempotent by `(turnId, callId)`; every answer carries the hold after it. */
  extend(turnId: string, callId: string, needMicro: number): Promise<({ ok: true } | { refused: 'cap_reached' | 'turn_budget' | 'held' }) & { ledgerHold: number }>
  /** Record a call's actual cost and set the turn's hold to `holdMicro`; a no-op once the turn is final. */
  close(turnId: string, callId: string, actualMicro: number, holdMicro: number): Promise<{ ledgerHold: number }>
  /** Final, from the tally only (design 9); the runner's own cost estimate is logged beside it, never added. */
  settle(turnId: string, micro: number, nowMs: number, runnerCostMicro?: number | null): Promise<void>
  release(turnId: string, nowMs: number): Promise<void>
}

// ---------- the file ledger (W3, p3-design 8.5) ----------

/** A chat file row (D1 `chat_files`, W3's `0120`). */
export interface ChatFile {
  id: string
  chatId: string
  kind: 'input' | 'output'
  path: string
  name: string
  contentType: string
  bytes: number
  sha256: string
  turnId: string | null
}

export interface FileLedgerPort {
  /** Flip the turn's pending output at `path` with this hash to saved (superseding the older saved row), idempotent. */
  confirm(chatId: string, turnId: string, path: string, sha256: string, nowMs: number): Promise<ChatFile | null>
  /**
   * The stored `input` rows of this chat for these ids, in the order asked, or the ids that aren't one. Route 29 builds
   * a turn's attachments (paths and names) from these rows, never from the names the client sent.
   */
  inputsOf(chatId: string, fileIds: readonly string[]): Promise<{ ok: true; files: ChatFile[] } | { missing: string[] }>
}

/** The ports compose.ts builds for one BrandAgent. */
export interface BrandAgentPorts {
  pool: RunnerPoolPort
  files: FileLedgerPort
  usage: UsageLedgerPort
}

// ---------- the BrandAgent's RPC surface ----------

/** A model call's worst case as the egress priced it before admission (8.2). */
export interface ModelCallWorst {
  /** The body's model (the turn's model or its side model). */
  model: string
  inputTokens: number
  maxTokens: number
  /** Price-affecting request values (cache TTL, search uses), as the egress read them. */
  modifiers: Readonly<Record<string, string | number | boolean>>
  micro: number
}

/** A call's usage so far (cumulative per field, 8.3) and its price at the catalogue's rates. */
export interface ModelCallUsage {
  inputTokens: number
  outputTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  cacheReadTokens: number
  webSearches: number
  micro: number
}

/** `granted`: send the upstream call after one confirming renew; `refused`: answer 400; `busy`: answer 503 for this call. */
export type AdmitAnswer = { granted: true } | { refused: 'cap_reached' | 'turn_budget' | 'budget_busy' } | { busy: true }
/** `gone`: the row was already closed (lease or unconfirmed grant): abort the upstream call. */
export type LeaseAnswer = { ok: true } | { gone: true }

/** Whose runs a read covers: one person's own, or every chat's (Inhouse under a grant). Never implied by a null. */
export type RunScope = { owner: string } | { all: true }

/** Who asks, as an API handler passes it on (a person, the smoke member, or Inhouse under a grant). */
export interface Actor {
  kind: 'person' | 'inhouse' | 'service'
  memberId: string
}

/** A turn as route 29 resolved it (p3-design 4.9) before handing it to the BrandAgent. */
export interface SubmitTurn {
  chatId: string
  input: SendTurnInput
  by: Actor
  /** The turn model's API id, its effort and the engine's background model. */
  model: string
  pickerId: string
  effort: Effort
  sideModel: string
  maxTurns: number
  /** null: any public host (an empty `t:webfetch`); a list narrows WebFetch to it. */
  webFetchDomains: string[] | null
}

/** The due task a turn's end schedules (PR 5, ask B): `{ id, kind }`, a registered kind. */
export interface OnEnd { kind: string; id: string }

/**
 * A turn submitted from inside the object (`TaskContext.runs.submit`, PR 5 ask A): route 29's resolved turn plus the
 * run's structured-output format (into `RunStart.outputFormat`) and the task its end schedules. Never from route 29's
 * body: `BrandAgentRpc.submitTurn` drops both.
 */
export type InternalSubmit = SubmitTurn & { outputFormat?: OutputFormat; onEnd?: OnEnd }

/**
 * The payload of a turn's `onEnd` task, fixed in the step that stores the turn final. `outcome` names how it ended:
 * `done`, `failed`, `stopped`, `interrupted` or `cancelled`; `failure` is the failure code (or, for a cancelled turn,
 * why it was cancelled), else null; `structuredOutput` the terminal event's value, else null.
 */
export interface TurnEndPayload {
  turnId: string
  runId: string
  chatId: string
  outcome: 'done' | 'failed' | 'stopped' | 'interrupted' | 'cancelled'
  failure: string | null
  structuredOutput: unknown
}

/** Route 47's answer: what's still running, and until when a drain holds. */
export interface DrainState {
  live: number
  starting: number
  ending: number
  queued: number
  drainingUntilMs: number | null
}

/** The run signals (W1, `ops/signals/runs.ts`): failures, stuck turns, damaged sessions, quarantined tasks. */
export interface RunsHealth {
  failures: SignalResult
  stuck: SignalResult
  damaged: SignalResult
  quarantined: SignalResult
}

export interface BrandAgentRpc {
  /** The egress's events route (8.6): store a pushed batch; `gone` once the turn ended (410). */
  ingest(turnId: string, events: RunEvent[]): Promise<PushAck | { gone: true }>
  /** The egress's token check (8.1): the hash, never the token. */
  checkRunToken(tokenHash: string, route: EgressRoute): Promise<RunGrant | { refused: TokenRefusal }>
  /**
   * Counts one of the CLI's own `count_tokens` calls (they pass unpriced, 8.2): true while the turn had made fewer than
   * 50 before it, false from then on. A conditional, atomic counter on the turn's row (count-tokens.ts).
   */
  noteCountTokens(turnId: string): Promise<boolean>
  admitModelCall(turnId: string, callId: string, worst: ModelCallWorst): Promise<AdmitAnswer>
  /** Confirms a grant (the first renew) and extends its 60 s lease with the running usage. */
  renewModelCall(turnId: string, callId: string, usage: ModelCallUsage): Promise<LeaseAnswer>
  /** Closes the call's slot; `cut`: the stream ended early (priced at its admitted worst case). */
  releaseModelCall(turnId: string, callId: string, end: { usage: ModelCallUsage; cut: boolean }): Promise<LeaseAnswer>
  submitTurn(turn: SubmitTurn): Promise<SendTurnResult | Refusal>
  interrupt(turnId: string, by: Actor): Promise<{ ok: true } | Refusal>
  stop(turnId: string, by: Actor): Promise<{ ok: true } | Refusal>
  pause(by: Actor): Promise<PauseState>
  resume(by: Actor): Promise<PauseState>
  getPause(): Promise<PauseState>
  resetSession(chatId: string, by: Actor): Promise<{ ok: true } | Refusal>
  /** The runs a caller may attach to, in its scope. */
  activeRuns(scope: RunScope): Promise<ActiveRun[]>
  /** A run's or a turn's trace; null when it isn't there or isn't in the scope. */
  /** Not `trace`: workerd keeps that name for the tail-worker handler, so an RPC call to it is refused. */
  getTrace(id: string, scope: RunScope): Promise<Trace | null>
  onMemberRemoved(memberId: string): Promise<void>
  onGrantEnded(grantId: string): Promise<void>
  /** A Runner's container exited: the pool names that runner's turns once per generation, and the BrandAgent fences them. */
  containerExited(runner: string, gen: number): Promise<void>
  poolHealth(): Promise<PoolHealth>
  runsHealth(): Promise<RunsHealth>
  /** `drain`, `drainState` and `warmup` delegate to the pool (`RunnerPoolPort`). */
  drain(): Promise<DrainState>
  drainState(): Promise<DrainState>
  warmup(): Promise<{ ok: true } | Refusal>
  /** The egress's audit route (8.7): the redacted `tool_calls` row, keyed `(turnId, n)`. */
  writeToolCall(turnId: string, n: number, entry: AuditEntry): Promise<void>
  /**
   * Schedules `{ id, kind, dueAtMs: dueAtMs ?? now }` (a past `dueAtMs` means now; `schedule()`, so any payload the task
   * had is dropped). Throws for an unregistered kind, or an id another kind's task holds.
   */
  poke(p: { kind: string; id: string; dueAtMs?: number }): Promise<void>
  /**
   * Clears one quarantined task (attempts 0, due now, its payload kept byte for byte); an ops action, logged. Throws for
   * an unregistered kind; a task of another kind is `not_found`.
   */
  revive(p: { kind: string; id: string }): Promise<'revived' | 'not_quarantined' | 'not_found'>
}
