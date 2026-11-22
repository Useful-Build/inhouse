// Reads over the BrandAgent's SQLite: route 32's active runs, route 33's trace and the runs signal (p3-design 3, 4.1;
// p3-w1.md "Runs signal"). Synchronous, no writes. Scope: a person's own runs (`owner`), or every chat's (Inhouse under
// a live grant; the API checks the grant before asking).
//
// CHOICES (the design names the sources, not the shapes):
// - Route 32 lists live runs and ended runs with a turn not yet in D1 (`d1_flushed = 0`; PR 3's projection flushes
//   them), oldest first. Route 24's `runs` (and every chat summary's `running`) is the same read narrowed to its chats.
// - Route 33's trace: the root (the run's or the turn's span), one `tool` step per tool call (from `turn_trace`'s step
//   records), a `fail` step for a hook that denied a call (an `approval` step for one deferred to a person; an allowed
//   hook adds nothing beside its step), one `model` step per model call that was granted (its grant to its close).
//   `cost` and `tokens` from the calls (closed at their price, open at their worst case, as the usage sweep reads them).
// - The runs signal: `runs_failed` is red when 3 turns of the last hour failed, or over 20% of them once at least 5 ended
//   (#159 rounds 1 and 2: a total outage at low volume still shows), counting failures other than the caps and the
//   brand's own choices (`cap_reached`, `turn_budget`, `budget_busy`, `model_off`; stop and interrupt aren't failures);
//   `runs_stuck` counts turns
//   the watchdog should have ended (a `starting` turn 5 minutes past its deadline; a running one 5 minutes past the
//   45-minute turn life); `session_damaged` counts chats damaged in the last 24 hours; `scheduler` counts quarantined
//   due tasks. Counts only.
import type { ActiveRun } from '../../../shared/contract/runs.ts'
import type { Trace, TraceStep } from '../../../shared/contract/trace.ts'
import type { ModelCallUsage, RunScope, RunsHealth } from './ports.ts'
import { callsMicro } from './turn-calls.ts'
import { ioFrom } from '@eval-trace'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** The turn's whole life (the token's 45 minutes, core.ts `TURN_MAX_MS`) and the slack past which it's stuck. */
const TURN_LIFE_MS = 45 * 60_000
const STUCK_SLACK_MS = 5 * 60_000
const FAILED_SHARE_MAX = 0.2
/** Fewer turns than this in the hour: the share isn't judged (one failure of two isn't an outage). */
const FAILED_SAMPLE_MIN = 5
/** This many failures in the hour are red whatever the volume. */
const FAILED_COUNT_MAX = 3

interface RunRow { [k: string]: SqlStorageValue; run_id: string; chat_id: string; owner_id: string; state: string; last_seq: number; started_at_ms: number; ended_at_ms: number | null }
interface TurnRead {
  [k: string]: SqlStorageValue
  turn_id: string; run_id: string; owner_id: string; text: string; outcome: string | null; failure: string | null
  created_at_ms: number; started_at_ms: number | null; ended_at_ms: number | null
}

const inScope = (owner: string, scope: RunScope) => ('all' in scope ? scope.all === true : owner === scope.owner)

/** `chatIds`: only these chats' runs (route 24); omitted, every chat's. */
export function activeRuns(sql: SqlStorage, scope: RunScope, chatIds?: string[]): ActiveRun[] {
  if (chatIds?.length === 0) return []
  const chats = chatIds === undefined ? '' : `r.chat_id IN (${chatIds.map(() => '?').join(', ')}) AND `
  const rows = sql.exec<RunRow>(
    `SELECT * FROM runs r WHERE ${chats}(r.state = 'live'
      OR EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.run_id AND t.d1_flushed = 0))
      ORDER BY r.started_at_ms, r.rowid`, ...(chatIds ?? [])).toArray()
  return rows.filter(r => inScope(r.owner_id, scope)).map(r => ({ runId: r.run_id, chatId: r.chat_id, lastSeq: r.last_seq, live: r.state === 'live' }))
}

const fmtTokens = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`)

/**
 * A run's (`r_…`) or a turn's (`t_…`) trace, or null when it isn't there or isn't in the scope. `evalIo`: the eval build
 * (core.ts passes it), where a `tool` step carries its call's kept input (`io`) for the run's owner only, never for
 * Inhouse's `all` scope (BD7, BD11; p3-eval-observability rev 2 rec 5), and `io.denied` when a hook denied that call
 * (rec 6: the eval harness's WebFetch refusal, matched by tool_use id, not by name).
 */
export function traceOf(sql: SqlStorage, id: string, scope: RunScope, nowMs: number, evalIo = false): Trace | null {
  let turns: TurnRead[]
  let startMs: number
  let endMs: number
  if (id.startsWith('r_')) {
    const run = sql.exec<RunRow>('SELECT * FROM runs WHERE run_id = ?', id).toArray()[0]
    if (!run || !inScope(run.owner_id, scope)) return null
    turns = sql.exec<TurnRead>('SELECT * FROM turns WHERE run_id = ? ORDER BY ord', id).toArray()
    startMs = run.started_at_ms
    endMs = run.ended_at_ms ?? nowMs
  } else {
    turns = sql.exec<TurnRead>('SELECT * FROM turns WHERE turn_id = ?', id).toArray()
    if (turns.length === 0 || !inScope(turns[0].owner_id, scope)) return null
    startMs = turns[0].started_at_ms ?? turns[0].created_at_ms
    endMs = turns[0].ended_at_ms ?? nowMs
  }
  const durationMs = Math.max(0, endMs - startMs)
  const at = (ms: number) => Math.min(Math.max(0, ms - startMs), durationMs)
  let micro = 0
  let tokens = 0
  const steps: TraceStep[] = []
  const withIo = evalIo && 'owner' in scope
  for (const t of turns) {
    micro += callsMicro(sql, t.turn_id)
    // A call's kept input may be recorded before or after its step (the audit post and the SDK message race), so the
    // turn's inputs are matched to its steps after the pass.
    const io = new Map<string, NonNullable<TraceStep['io']>>()
    const denied = new Set<string>()
    const toolSteps: [TraceStep, string][] = []
    for (const r of sql.exec<{ at_ms: number; json: string }>('SELECT at_ms, json FROM turn_trace WHERE turn_id = ? ORDER BY n', t.turn_id).toArray()) {
      const rec = JSON.parse(r.json) as Record<string, string>
      if (rec.step !== undefined) {
        const step: TraceStep = { label: rec.step, kind: 'tool', startMs: at(r.at_ms), endMs: at(r.at_ms), depth: 1, detail: rec.tool ?? '' }
        steps.push(step)
        if (withIo && rec.id !== undefined) toolSteps.push([step, rec.id])
      } else if (rec.io !== undefined) {
        const kept = withIo ? ioFrom(rec) : null
        if (kept !== null) io.set(kept[0], kept[1])
      } else if (rec.audit !== undefined && rec.decision !== 'allow') {
        if (withIo && rec.decision === 'deny' && rec.id !== undefined) denied.add(rec.id)
        steps.push({ label: rec.audit, kind: rec.decision === 'deny' ? 'fail' : 'approval', startMs: at(r.at_ms), endMs: at(r.at_ms), depth: 1, detail: `${rec.hook} · ${rec.decision}` })
      }
    }
    for (const [step, toolUseId] of toolSteps) {
      const kept = io.get(toolUseId)
      // A denied call with no kept input still says so: an empty input marked cut, never a listed-looking one.
      if (denied.has(toolUseId)) step.io = { ...(kept ?? { input: '', cut: true }), denied: true }
      else if (kept !== undefined) step.io = kept
    }
    const calls = sql.exec<{ model: string; granted_at_ms: number; closed_at_ms: number | null; state: string; usage_json: string | null }>(
      'SELECT model, granted_at_ms, closed_at_ms, state, usage_json FROM model_calls WHERE turn_id = ? AND granted_at_ms IS NOT NULL ORDER BY n', t.turn_id).toArray()
    for (const c of calls) {
      const u = c.usage_json === null ? null : JSON.parse(c.usage_json) as Pick<ModelCallUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWrite5mTokens' | 'cacheWrite1hTokens' | 'refused'>
      const input = u ? u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens : 0
      const output = u ? u.outputTokens : 0
      tokens += input + output
      // A refused call never ran (the model service's own error, closed at zero); an open one (no close yet) carries only
      // its last renew's running usage, so neither reads as a finished zero-token step. Both lead with the model, as the
      // trace window's plain view reads a model step's detail after its first ` · `.
      const counts = `${input} in · ${output} out`
      const detail = u?.refused === true ? `${c.model} · refused by the model service`
        : c.closed_at_ms === null ? `${c.model} · in progress${input + output > 0 ? ` · ${counts} so far` : ''}`
        : `${counts}${c.state === 'cut' ? ' · cut' : ''}`
      // Open and not refused: priced at its worst case in the cost below until it closes.
      const upTo = c.closed_at_ms === null && u?.refused !== true
      steps.push({ label: c.model, kind: 'model', startMs: at(c.granted_at_ms), endMs: at(c.closed_at_ms ?? nowMs), depth: 1, detail, ...(upTo ? { costUpTo: true } : {}) })
    }
  }
  // Stable: records of one moment keep their order (steps, then hooks, then calls).
  steps.sort((a, b) => a.startMs - b.startMs)
  const root: TraceStep = { label: 'Inhouse agent', kind: 'root', startMs: 0, endMs: durationMs, depth: 0, detail: `${turns.length} ${turns.length === 1 ? 'question' : 'questions'}` }
  return {
    id, title: (turns[0]?.text ?? '').slice(0, 120), durationMs, cost: { minor: Math.round(micro / 10_000), currency: 'USD' },
    tokens: fmtTokens(tokens), steps: [root, ...steps],
  }
}

export function runsHealth(sql: SqlStorage, nowMs: number, quarantined: number): RunsHealth {
  const n = (q: string, ...a: SqlStorageValue[]) => sql.exec<{ n: number }>(q, ...a).one().n
  const ended = n("SELECT COUNT(*) AS n FROM turns WHERE state = 'ended' AND ended_at_ms >= ?", nowMs - HOUR_MS)
  // Known gap (#159 round 2): with `budget_busy` left out, a gate that refuses `held` when it shouldn't (the round 1 F1
  // class) shows on no signal here; only the gate's tests cover it. A hold that leaks still shows on W4's
  // `usage_stranded` after about 2 hours.
  const failed = n(
    "SELECT COUNT(*) AS n FROM turns WHERE state = 'ended' AND ended_at_ms >= ? AND outcome = 'failed' AND COALESCE(failure, '') NOT IN ('cap_reached', 'turn_budget', 'budget_busy', 'model_off')",
    nowMs - HOUR_MS)
  const stuck = n(
    `SELECT COUNT(*) AS n FROM turns WHERE (state = 'starting' AND starting_deadline_ms < ?)
      OR (state IN ('live', 'ending') AND COALESCE(started_at_ms, created_at_ms) < ?)`,
    nowMs - STUCK_SLACK_MS, nowMs - TURN_LIFE_MS - STUCK_SLACK_MS)
  const damaged = n('SELECT COUNT(*) AS n FROM chat_state WHERE damaged_at_ms >= ?', nowMs - DAY_MS)
  return {
    failures: { ok: failed < FAILED_COUNT_MAX && (ended < FAILED_SAMPLE_MIN || failed / ended <= FAILED_SHARE_MAX), detail: `${failed} of ${ended} failed in the last hour` },
    stuck: { ok: stuck === 0, detail: `${stuck} stuck` },
    damaged: { ok: damaged === 0, detail: `${damaged} damaged in 24 h` },
    quarantined: { ok: quarantined === 0, detail: `${quarantined} quarantined` },
  }
}
