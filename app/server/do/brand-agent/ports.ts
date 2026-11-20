// The BrandAgent's ports (p3-design section 12): what it calls out to (the runner pool, the usage ledger, the file
// ledger), each built in compose.ts by its owner, and the RPC surface other parts of the Worker call it through
// (`BrandAgentRpc`: the egress, the API handlers, the Runner objects, the health signals). W1's first PR defines them
// with a fake of each under testing/; W2, W3 and W4 fill the real pool, files and usage ports. Every amount is in
// micro-USD, every time in epoch ms.
import type { AuditEntry, PushAck, RunEvent, RunStart } from '../../../shared/protocol/index.ts'
import type { AgentErrorCode, ErrorReason } from '../../../shared/contract/common.ts'
import type { Trace } from '../../../shared/contract/trace.ts'
import type { ActiveRun, PauseState, SendTurnInput, SendTurnResult } from '../../../shared/contract/runs.ts'
import type { Effort } from '../../../shared/contract/common.ts'
import type { SignalResult } from '../../ops/signals/types.ts'
import type { EgressRoute, RunGrant, TokenRefusal } from './tokens.ts'

/** A refusal the API answers with its code and reason (P2's error body). */
export type Refusal = { refused: { code: AgentErrorCode; reason?: ErrorReason } }

// ---------- the runner pool (W2, p3-design section 7) ----------

/** The answer of one runner's `GET /runs/:id`, or `unreachable` when the runner didn't answer. */
export type RunnerTurnStatus = 'live' | 'ended' | 'unknown' | 'unreachable'

/** The pool's health signals (section 7): `pool_protocol`, `pool_restarts`, `pool_shortfall`. Counts only. */
export interface PoolHealth {
  protocol: SignalResult
  restarts: SignalResult
  shortfall: SignalResult
}

export interface RunnerPoolPort {
  /**
   * Place a turn (`rs.runId` is the turn id) on a runner. `admitted`: the runner's name; `queued`: in the placement
   * queue; a definite refusal; `ambiguous`: the request may have reached the runner named (never try another).
   * `gen` is the turn's generation at the claim, so an answer for an older attempt can be told apart.
   */
  place(rs: RunStart, gen: number): Promise<{ admitted: string } | { queued: true } | { refused: 'pool_full' | 'files' | 'draining' } | { ambiguous: string }>
  interrupt(runner: string, turnId: string): Promise<void>
  stop(runner: string, turnId: string): Promise<void>
  status(runner: string, turnId: string): Promise<RunnerTurnStatus>
  /** The turn released its runner (the next placement may use the slot). */
  turnEnded(runner: string, turnId: string): void
  health(): PoolHealth
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
  settle(turnId: string, micro: number, nowMs: number): Promise<void>
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
  /** Whether every id is an `input` of this chat. */
  inputsOf(chatId: string, fileIds: readonly string[]): Promise<{ ok: true } | { missing: string[] }>
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
  /** The runs a caller may attach to: a person's own (`ownerId`), or every chat's for Inhouse under a grant (null). */
  activeRuns(ownerId: string | null): Promise<ActiveRun[]>
  /** A run's or a turn's trace; null when it isn't there or isn't the owner's. */
  trace(id: string, ownerId: string | null): Promise<Trace | null>
  onMemberRemoved(memberId: string): Promise<void>
  onGrantEnded(grantId: string): Promise<void>
  /** A Runner's container exited: fence that runner's turns, once per generation. */
  containerExited(runner: string, gen: number): Promise<void>
  poolHealth(): Promise<PoolHealth>
  runsHealth(): Promise<RunsHealth>
  drain(): Promise<DrainState>
  drainState(): Promise<DrainState>
  warmup(): Promise<{ ok: true } | Refusal>
  /** The egress's audit route (8.7): the redacted `tool_calls` row, keyed `(turnId, n)`. */
  writeToolCall(turnId: string, n: number, entry: AuditEntry): Promise<void>
}
