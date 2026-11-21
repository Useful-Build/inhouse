// Test helpers for the routines tests (server/routines/*.test.ts, in the Workers runtime on the migrated test D1). Never
// imported by the Worker. The reference fake of `runs.submit` is independent of the tick: it keeps turns by `(chatId,
// clientTurnKey)` and P3's payload hash (run-start.ts `submitPayloadHash`, line A's answer 2), answers the original
// turn for a same-payload re-submit and `conflict/key_reused` for a changed one, and records every `onEnd.id`.
import { env } from 'cloudflare:workers'
import type { SendTurnResult } from '../../shared/contract/runs.ts'
import type { ChatStatus, InternalSubmit, Refusal, TurnEndPayload } from '../do/brand-agent/ports.ts'
import { submitPayloadHash } from '../do/brand-agent/run-start.ts'
import type { DueTask, Scheduler } from '../do/brand-agent/scheduler.ts'
import { routineEnd } from './end.ts'
import type { RoutineRow, SlotRow } from './rows.ts'
import { routineTick, TICK_ID, TICK_KIND } from './tick.ts'
import type { TickContext } from './tick.ts'

export const db: D1Database = env.DB

const rand = (n: number) => {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => a[b % 64]).join('')
}
/** A fresh routine id (`rt_` + 22), so each test's rows and Activity keys are its own. */
export const routineIdFor = (): string => `rt_${rand(22)}`
export const turnIdFor = (): string => `t_${rand(22)}`
export const runIdFor = (): string => `r_${rand(22)}`

export async function setSetting(key: string, value: string | null): Promise<void> {
  await db.prepare(
    `INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', ?, ?, 1, 0, 'm_system', 'test')
      ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1`,
  ).bind(key, JSON.stringify(value)).run()
}
export const setStage = (stage: 'Watch' | 'Act' | 'Run') => setSetting('stage', stage)
export const setZone = (tz: string) => setSetting('g:tz', tz)

/** A person member (`active`). */
export async function addPerson(id: string, role: 'member' | 'admin' = 'member'): Promise<string> {
  await db.prepare(
    "INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', ?, 'active', 'Test person', 0) ON CONFLICT (id) DO UPDATE SET status = 'active', role = excluded.role",
  ).bind(id, role).run()
  return id
}

export function routine(over: Partial<RoutineRow> & Pick<RoutineRow, 'creator_id' | 'checked_until_ms'>): RoutineRow {
  const id = over.id ?? routineIdFor()
  return {
    id, origin: 'team', kind: 'agent', name: 'Check stock', instruction: 'Check the stock levels.', prompt_ref: null,
    days_mask: 127, hour: 6, minute: 0, missed: 'skip', catch_up_within_min: 360, need: 1, enabled: 1, deleted_at_ms: null,
    source_chat_id: null, last_slot_key: null, created_at_ms: over.checked_until_ms, updated_at_ms: over.checked_until_ms, rev: 1,
    ...over,
  }
}

export async function insertRoutine(r: RoutineRow): Promise<RoutineRow> {
  const cols = Object.keys(r) as (keyof RoutineRow)[]
  await db.prepare(`INSERT INTO routines (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...cols.map(c => r[c])).run()
  return r
}

export const slotsOf = async (routineId: string): Promise<SlotRow[]> =>
  (await db.prepare('SELECT * FROM routine_slots WHERE routine_id = ? ORDER BY due_at_ms, slot_key').bind(routineId).all<SlotRow>()).results

export const linesOf = async (routineId: string): Promise<{ template: string; source_key: string; trace: string | null; fields_json: string }[]> =>
  (await db.prepare("SELECT template, source_key, trace, fields_json FROM activity_lines WHERE source = 'routine-slot' AND (source_key LIKE ? OR source_key LIKE ?) ORDER BY at_ms, source_key")
    .bind(`${routineId}|%`, `now|${routineId}|%`).all<{ template: string; source_key: string; trace: string | null; fields_json: string }>()).results

export interface FakeTurn {
  turnId: string
  runId: string
  chatId: string
  clientTurnKey: string
  hash: string
  submit: InternalSubmit
  ended: boolean
}

/** The reference fake of `TaskContext.runs.submit`. `refuse` answers before any turn is made; `afterSubmit` runs once one is. */
export class FakeRuns {
  readonly turns = new Map<string, FakeTurn>()
  readonly onEndIds = new Map<string, number>()
  calls = 0
  refuse: ((t: InternalSubmit) => Refusal | undefined) | undefined
  /** Runs before a new turn is made (never for a re-submit the fake dedupes). */
  beforeNew: ((t: InternalSubmit) => Promise<void>) | undefined
  afterSubmit: ((turn: FakeTurn) => void) | undefined

  async submit(t: InternalSubmit): Promise<SendTurnResult | Refusal> {
    this.calls++
    const r = this.refuse?.(t)
    if (r) return r
    const key = `${t.chatId}|${t.input.clientTurnKey}`
    const hash = await submitPayloadHash({ ...t.input, effort: t.effort, outputFormat: t.outputFormat, onEnd: t.onEnd })
    const had = this.turns.get(key)
    if (had) {
      if (had.hash !== hash) return { refused: { code: 'conflict', reason: 'key_reused' } }
      return { runId: had.runId, turnId: had.turnId, messageId: `${had.turnId}.u`, position: 'starting' }
    }
    await this.beforeNew?.(t)
    const turn: FakeTurn = { turnId: turnIdFor(), runId: runIdFor(), chatId: t.chatId, clientTurnKey: t.input.clientTurnKey, hash, submit: t, ended: false }
    this.turns.set(key, turn)
    if (t.onEnd) this.onEndIds.set(t.onEnd.id, (this.onEndIds.get(t.onEnd.id) ?? 0) + 1)
    this.afterSubmit?.(turn)
    return { runId: turn.runId, turnId: turn.turnId, messageId: `${turn.turnId}.u`, position: 'starting' }
  }

  /** The turn of a slot's chat. */
  byChat(chatId: string): FakeTurn | undefined {
    return [...this.turns.values()].find(t => t.chatId === chatId)
  }
}

/** A scheduler that records what the handlers schedule. */
export class FakeScheduler implements Scheduler {
  readonly scheduled: { id: string; kind: string; dueAtMs: number }[] = []
  schedule(t: { id: string; kind: string; dueAtMs: number }): void {
    this.scheduled.push({ id: t.id, kind: t.kind, dueAtMs: t.dueAtMs })
  }
  ensure(): void {
    throw new Error('the routine handlers never ensure')
  }
  cancel(): void {
    throw new Error('the routine handlers never cancel')
  }
  /** The heartbeat's last due time. */
  heartbeatAt(): number | undefined {
    return this.scheduled.filter(s => s.id === TICK_ID).at(-1)?.dueAtMs
  }
}

export interface Harness {
  runs: FakeRuns
  scheduler: FakeScheduler
  status: Map<string, ChatStatus>
  ctx(now: number, d1?: D1Database): TickContext
  tick(now: number, id?: string, d1?: D1Database): Promise<void>
  /** Delivers a turn's end to `routine-end` as P3 would (seam B's payload). */
  end(turn: FakeTurn, now: number, e?: Partial<Pick<TurnEndPayload, 'outcome' | 'failure' | 'structuredOutput'>>, d1?: D1Database): Promise<void>
}

export function harness(): Harness {
  const runs = new FakeRuns()
  const scheduler = new FakeScheduler()
  const status = new Map<string, ChatStatus>()
  const ctx = (now: number, d1: D1Database = db): TickContext => ({
    nowMs: now, env: { DB: d1 } as unknown as Env, scheduler, runs: { submit: t => runs.submit(t) },
    chats: { status: chatId => status.get(chatId) ?? { waiting: false, liveRunId: null } },
  })
  const task = (id: string, kind: string, now: number, payload: unknown = null): DueTask => ({ id, kind, gen: 1, dueAtMs: now, payload, attempts: 0 })
  return {
    runs, scheduler, status, ctx,
    async tick(now, id = TICK_ID, d1) {
      await routineTick(task(id, TICK_KIND, now), ctx(now, d1))
    },
    async end(turn, now, e = {}, d1) {
      const onEnd = turn.submit.onEnd
      if (!onEnd) throw new Error('the turn has no onEnd')
      const payload: TurnEndPayload = {
        turnId: turn.turnId, runId: turn.runId, chatId: turn.chatId,
        outcome: e.outcome ?? 'done', failure: e.failure ?? null, structuredOutput: e.structuredOutput ?? null,
      }
      turn.ended = true
      const answer = await routineEnd(task(onEnd.id, onEnd.kind, now, payload), ctx(now, d1))
      if (!('done' in answer)) throw new Error('routine-end did not answer done')
    },
  }
}

export const at = (iso: string): number => {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`at: ${iso}`)
  return ms
}
export const MIN = 60_000

/** Every routine, slot and routine chat gone (Activity is append-only: tests tell lines apart by their routine ids). */
export async function fresh(): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM routine_slots'),
    db.prepare('DELETE FROM routines'),
    db.prepare('DELETE FROM routine_alerts'),
    db.prepare("DELETE FROM chats WHERE owner_id = 'm_system'"),
  ])
}

/** A crash: the object died at this await. Every later call of the same wrapped D1 throws it too (nothing more is written). */
export class Crash extends Error {
  constructor() {
    super('crash')
    this.name = 'Crash'
  }
}

const UNWRAP = Symbol('unwrap')

export interface WrappedD1 {
  db: D1Database
  /** Calls made so far. */
  calls(): number
  /** Kill it now: every later call throws `Crash`. */
  kill(): void
  dead(): boolean
}

/**
 * The raw D1 with a hook before every call (`n` counts from 0): the hook may run a route write on the raw D1 first (a
 * write between the handler's read and its batch) or throw `Crash`. Once crashed, every call throws.
 */
export function wrapD1(raw: D1Database, before?: (kind: 'read' | 'run' | 'batch', n: number) => Promise<void>): WrappedD1 {
  let n = 0
  let dead = false
  const gate = async (kind: 'read' | 'run' | 'batch') => {
    if (dead) throw new Crash()
    const i = n++
    try {
      await before?.(kind, i)
    } catch (err) {
      if (err instanceof Crash) dead = true
      throw err
    }
  }
  const wrap = (s: D1PreparedStatement): D1PreparedStatement => ({
    [UNWRAP]: s,
    bind: (...v: unknown[]) => wrap(s.bind(...v)),
    first: async (col?: string) => {
      await gate('read')
      return col === undefined ? s.first() : s.first(col)
    },
    all: async () => {
      await gate('read')
      return s.all()
    },
    run: async () => {
      await gate('run')
      return s.run()
    },
    raw: async () => {
      await gate('read')
      return s.raw()
    },
  }) as unknown as D1PreparedStatement
  const unwrap = (s: D1PreparedStatement) => (s as unknown as { [UNWRAP]?: D1PreparedStatement })[UNWRAP] ?? s
  const db = {
    prepare: (q: string) => wrap(raw.prepare(q)),
    batch: async (stmts: D1PreparedStatement[]) => {
      await gate('batch')
      return raw.batch(stmts.map(unwrap))
    },
  } as unknown as D1Database
  return { db, calls: () => n, kill: () => { dead = true }, dead: () => dead }
}
