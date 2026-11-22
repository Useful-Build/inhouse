// Retention's custom jobs for P3 and P4's stores (P8 C1). Each job serves the store whose rule names it and may remove
// rows of other stores with it (a chat's messages, a notice's reads, an upload's object and mark). A job's plan reads,
// writes nothing, counts and fixes its units (at most `limit`: the handler's budget); its run takes only those units,
// re-checks each against the plan's cutoffs (never a new clock) and removes it, objects before rows, children before
// parents. Every round's ids or keys go in a `progress` entry. A run that left candidates says `more`.
// D1 binds at most 100 parameters per query (https://developers.cloudflare.com/d1/platform/limits/, read 2026-11-22):
// rounds stay under it, and so must `limit` (MAX_LIMIT), since a plan counts its units in one IN list.
import type { KeyedBucket } from '../../../server/db/r2-keys.ts'
import { all, first, runBatch, stmt } from '../../../server/db/sql.ts'
import type { SqlValue, Stmt } from '../../../server/db/sql.ts'
import { deleteKeys } from '../../delete/r2.ts'
import { DEFAULT_DAYS } from '../../retention/rules.ts'
import type { PeriodName } from '../../retention/rules.ts'
import { countChatRows, countRunRows, deleteChatRows, deleteRunRows, endedRuns, quietChats } from './brand-agent-storage.ts'
import { CASCADE_R2, cascadeRowStatements, chatsIn, countCascade, deleteCascadeObjects } from './chat-cascade.ts'

const DAY_MS = 86_400_000
/** The most units one plan may fix: its IN lists bind them, beside a cutoff or two. */
export const MAX_LIMIT = 90

export interface JobContext {
  db: D1Database
  /** Keys come from rows the product wrote through r2-keys.ts (`r2_key` columns) or its prefix builders. */
  bucket: KeyedBucket
  /** The BrandAgent's storage: present only when retention runs inside the object (the handler). */
  sql?: SqlStorage
  /** The plan's clock. */
  atMs: number
  /** The store's own cutoff from its period (`periods`), when it has one. */
  cutoffMs: number | null
  /** At most this many units (chats, files, rows...) per run. */
  limit: number
}

export interface JobPlan {
  counts: Record<string, number>
  /** The units the run removes (ids), fixed at plan time. */
  units: readonly string[]
  cutoffs: { store: string; cutoffMs: number }[]
  more: boolean
}

export interface JobRun {
  removed: Record<string, number>
  /** Each round's ids or keys per store, for the log's `progress` entries. */
  rounds: { store: string; ids?: string[]; keys?: string[]; count: number }[][]
}

export interface RetentionJob {
  plan(ctx: JobContext): Promise<JobPlan>
  run(ctx: JobContext, plan: JobPlan, round: (entries: JobRun['rounds'][number]) => Promise<void>): Promise<Record<string, number>>
}

/** A fixed period's cutoff from the plan's clock. */
export const fixedCutoff = (atMs: number, period: PeriodName) => atMs - DEFAULT_DAYS[period] * DAY_MS
const own = (ctx: JobContext, store: string) => {
  if (ctx.cutoffMs === null) throw new Error(`retention: ${store}'s job needs its period`)
  return ctx.cutoffMs
}
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ') || 'NULL'
const add = (into: Record<string, number>, from: Record<string, number>) => { for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v }
async function ids(db: D1Database, sql: string, params: SqlValue[], limit: number): Promise<{ units: string[]; more: boolean }> {
  const rows = await all<{ id: string }>(db, stmt(`${sql} LIMIT ?`, ...params, limit + 1))
  return { units: rows.slice(0, limit).map(r => String(r.id)), more: rows.length > limit }
}
async function count(db: D1Database, s: Stmt): Promise<number> {
  const r = await first<{ n: number }>(db, s)
  if (!r) throw new Error('retention: no count')
  return r.n
}
/** Runs the statements in one batch; each returns a row per row it deleted (D1's `meta.changes` counts trigger writes too). */
async function deleted(db: D1Database, batch: { store: string; stmt: Stmt }[]): Promise<Record<string, number>> {
  const results = await runBatch(db, batch.map(b => ({ ...b.stmt, sql: `${b.stmt.sql} RETURNING 1 AS gone` })))
  const out: Record<string, number> = {}
  batch.forEach((b, i) => add(out, { [b.store]: results[i].results.length }))
  return out
}
const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

// ---------- the chat cascade: chats past retention, with everything that goes with them ----------

const CHATS_ROUND = 10

/** A chat whose last activity is past the chats period, or whose trash time is past the trash period. */
function pastChats(ctx: JobContext) {
  const chatsCut = own(ctx, 'chats')
  const trashCut = fixedCutoff(ctx.atMs, 'trash')
  return { where: 'c.last_at_ms < ? OR (c.deleted_at_ms IS NOT NULL AND c.deleted_at_ms < ?)', params: [chatsCut, trashCut] as SqlValue[], chatsCut, trashCut }
}

export const chatCascade: RetentionJob = {
  async plan(ctx) {
    const past = pastChats(ctx)
    const found = await ids(ctx.db, `SELECT c.id AS id FROM chats c WHERE ${past.where} ORDER BY c.id`, past.params, ctx.limit)
    // A chat whose BrandAgent rows are busy waits for a later run (with the object's storage; without it, no rows of the
    // object are touched, and the in-object run takes them).
    const units = ctx.sql ? quietChats(ctx.sql, found.units) : found.units
    const counts: Record<string, number> = await countCascade(ctx.db, ctx.bucket, chatsIn(units), units)
    if (ctx.sql) counts.BrandAgent = Object.values(countChatRows(ctx.sql, units)).reduce((a, b) => a + b, 0)
    return { counts, units, cutoffs: [{ store: 'chats', cutoffMs: past.chatsCut }, { store: 'chats:trash', cutoffMs: past.trashCut }], more: found.more || units.length < found.units.length }
  },
  async run(ctx, plan, round) {
    const past = pastChats(ctx)
    const removed: Record<string, number> = {}
    for (const batchIds of chunks(plan.units, CHATS_ROUND)) {
      // Still past retention (a chat with new activity since the plan stays).
      const still = (await all<{ id: string }>(ctx.db, stmt(`SELECT c.id AS id FROM chats c WHERE c.id IN (${marks(batchIds.length)}) AND (${past.where})`, ...batchIds, ...past.params))).map(r => r.id)
      const quiet = ctx.sql ? quietChats(ctx.sql, still) : still
      if (quiet.length === 0) continue
      const objects = await deleteCascadeObjects(ctx.bucket, quiet)
      const rows = await deleted(ctx.db, cascadeRowStatements(chatsIn(quiet)))
      const entries: JobRun['rounds'][number] = [{ store: 'chats', ids: quiet, count: rows.chats ?? 0 }]
      for (const p of CASCADE_R2) entries.push({ store: p, keys: objects[p], count: objects[p].length })
      for (const [store, n] of Object.entries(rows)) if (store !== 'chats') entries.push({ store, count: n })
      add(removed, rows)
      for (const p of CASCADE_R2) add(removed, { [p]: objects[p].length })
      if (ctx.sql) {
        const agent = Object.values(deleteChatRows(ctx.sql, quiet)).reduce((a, b) => a + b, 0)
        add(removed, { BrandAgent: agent })
        entries.push({ store: 'BrandAgent', ids: quiet, count: agent })
      }
      await round(entries)
    }
    return removed
  },
}
// ---------- tool calls by their own age (composite key) ----------

const ROWS_ROUND = 90
/** Two parameters per tool call (its composite key), beside the cutoff. */
const CALLS_ROUND = 45

export const toolCallsSteps: RetentionJob = {
  async plan(ctx) {
    const cut = own(ctx, 'tool_calls')
    const found = await ids(ctx.db, "SELECT turn_id || ':' || n AS id FROM tool_calls WHERE at_ms < ? ORDER BY turn_id, n", [cut], ctx.limit)
    return { counts: { tool_calls: found.units.length }, units: found.units, cutoffs: [{ store: 'tool_calls', cutoffMs: cut }], more: found.more }
  },
  async run(ctx, plan, round) {
    const cut = own(ctx, 'tool_calls')
    let n = 0
    for (const part of chunks(plan.units, CALLS_ROUND)) {
      const keys = part.map(u => { const i = u.lastIndexOf(':'); return [u.slice(0, i), Number(u.slice(i + 1))] as [string, number] })
      const gone = await deleted(ctx.db, [{ store: 'tool_calls', stmt: stmt(`DELETE FROM tool_calls WHERE at_ms < ? AND (turn_id, n) IN (VALUES ${keys.map(() => '(?, ?)').join(', ')})`, cut, ...keys.flat()) }])
      n += gone.tool_calls ?? 0
      await round([{ store: 'tool_calls', ids: part, count: gone.tool_calls ?? 0 }])
    }
    return { tool_calls: n }
  },
}

// ---------- a Library-deleted chat output, 30 days after its mark ----------

const FILES_ROUND = 50

export const chatFilesTrash: RetentionJob = {
  async plan(ctx) {
    const cut = fixedCutoff(ctx.atMs, 'trash')
    const found = await ids(ctx.db, "SELECT f.id AS id FROM chat_files f JOIN library_marks m ON m.file_id = f.id AND m.source = 'chat' WHERE m.deleted_at_ms < ? ORDER BY f.id", [cut], ctx.limit)
    return { counts: { chat_files: found.units.length, library_marks: found.units.length, 'files/': found.units.length }, units: found.units, cutoffs: [{ store: 'chat_files:trash', cutoffMs: cut }], more: found.more }
  },
  async run(ctx, plan, round) {
    const cut = fixedCutoff(ctx.atMs, 'trash')
    const removed: Record<string, number> = {}
    for (const part of chunks(plan.units, FILES_ROUND)) {
      const files = await all<{ id: string; r2_key: string }>(ctx.db, stmt(`SELECT f.id, f.r2_key FROM chat_files f JOIN library_marks m ON m.file_id = f.id AND m.source = 'chat' WHERE m.deleted_at_ms < ? AND f.id IN (${marks(part.length)})`, cut, ...part))
      if (files.length === 0) continue
      const keys = files.map(f => f.r2_key)
      await deleteKeys(ctx.bucket, keys)
      const fileIds = files.map(f => f.id)
      const rows = await deleted(ctx.db, [
        { store: 'library_marks', stmt: stmt(`DELETE FROM library_marks WHERE source = 'chat' AND file_id IN (${marks(fileIds.length)})`, ...fileIds) },
        { store: 'chat_files', stmt: stmt(`DELETE FROM chat_files WHERE id IN (${marks(fileIds.length)})`, ...fileIds) },
      ])
      add(removed, { ...rows, 'files/': keys.length })
      await round([{ store: 'chat_files', ids: fileIds, count: rows.chat_files ?? 0 }, { store: 'library_marks', ids: fileIds, count: rows.library_marks ?? 0 }, { store: 'files/', keys, count: keys.length }])
    }
    return removed
  },
}

// ---------- the BrandAgent's ended runs, by ended_at_ms ----------

const RUNS_ROUND = 25

export const brandAgentSteps: RetentionJob = {
  async plan(ctx) {
    if (!ctx.sql) throw new Error("retention: the BrandAgent's job runs only inside the object (TaskContext.sql)")
    const cut = own(ctx, 'BrandAgent')
    const found = endedRuns(ctx.sql, cut, ctx.limit)
    const counts = countRunRows(ctx.sql, found.runIds)
    return { counts: { BrandAgent: Object.values(counts).reduce((a, b) => a + b, 0) }, units: found.runIds, cutoffs: [{ store: 'BrandAgent', cutoffMs: cut }], more: found.more }
  },
  async run(ctx, plan, round) {
    if (!ctx.sql) throw new Error("retention: the BrandAgent's job runs only inside the object (TaskContext.sql)")
    const cut = own(ctx, 'BrandAgent')
    let n = 0
    for (const part of chunks(plan.units, RUNS_ROUND)) {
      // Still ended, still past the cutoff, still safe (re-read: a run is never revived, but a turn's hold may be).
      const safe = new Set(endedRuns(ctx.sql, cut, Number.MAX_SAFE_INTEGER).runIds)
      const runs = part.filter(r => safe.has(r))
      const gone = Object.values(deleteRunRows(ctx.sql, runs)).reduce((a, b) => a + b, 0)
      n += gone
      await round([{ store: 'BrandAgent', ids: runs, count: gone }])
    }
    return { BrandAgent: n }
  },
}

// ---------- by-id deletes with a condition (routine slots, forgotten memories) ----------

function byIds(store: string, idColumn: string, condition: (ctx: JobContext) => { where: string; params: SqlValue[]; cutoffs: JobPlan['cutoffs'] }): RetentionJob {
  return {
    async plan(ctx) {
      const c = condition(ctx)
      const found = await ids(ctx.db, `SELECT ${idColumn} AS id FROM ${store} WHERE ${c.where} ORDER BY ${idColumn}`, c.params, ctx.limit)
      return { counts: { [store]: found.units.length }, units: found.units, cutoffs: c.cutoffs, more: found.more }
    },
    async run(ctx, plan, round) {
      const c = condition(ctx)
      let n = 0
      for (const part of chunks(plan.units, ROWS_ROUND)) {
        const gone = await deleted(ctx.db, [{ store, stmt: stmt(`DELETE FROM ${store} WHERE ${idColumn} IN (${marks(part.length)}) AND (${c.where})`, ...part, ...c.params) }])
        n += gone[store] ?? 0
        await round([{ store, ids: part, count: gone[store] ?? 0 }])
      }
      return { [store]: n }
    },
  }
}

/** A slot past the steps period, unless a today item still references it (0220's foreign key, no ON DELETE). */
export const routineSlots = byIds('routine_slots', 'slot_key', ctx => {
  const cut = own(ctx, 'routine_slots')
  return { where: 'claimed_at_ms < ? AND NOT EXISTS (SELECT 1 FROM today_items t WHERE t.slot_key = routine_slots.slot_key)', params: [cut], cutoffs: [{ store: 'routine_slots', cutoffMs: cut }] }
})

/** A forgotten fact 30 days after its last update; active and waiting facts never (config). */
export const forgottenMemories = byIds('memories', 'n', ctx => {
  const cut = fixedCutoff(ctx.atMs, 'forgottenMemory')
  return { where: "status = 'forgotten' AND updated_at_ms < ?", params: [cut], cutoffs: [{ store: 'memories', cutoffMs: cut }] }
})

// ---------- notices, after their reads ----------

const NOTICES_ROUND = 90

export const noticesSteps: RetentionJob = {
  async plan(ctx) {
    const cut = own(ctx, 'notices')
    const found = await ids(ctx.db, 'SELECT id FROM notices WHERE at_ms < ? ORDER BY id', [cut], ctx.limit)
    const reads = found.units.length === 0 ? 0 : await count(ctx.db, stmt(`SELECT COUNT(*) AS n FROM notice_reads WHERE notice_id IN (${marks(found.units.length)})`, ...found.units))
    return { counts: { notices: found.units.length, notice_reads: reads }, units: found.units, cutoffs: [{ store: 'notices', cutoffMs: cut }], more: found.more }
  },
  async run(ctx, plan, round) {
    const cut = own(ctx, 'notices')
    const removed: Record<string, number> = {}
    for (const part of chunks(plan.units, NOTICES_ROUND)) {
      const old = `SELECT id FROM notices WHERE at_ms < ? AND id IN (${marks(part.length)})`
      const rows = await deleted(ctx.db, [
        // Reads first: notice_reads references notices.
        { store: 'notice_reads', stmt: stmt(`DELETE FROM notice_reads WHERE notice_id IN (${old})`, cut, ...part) },
        { store: 'notices', stmt: stmt(`DELETE FROM notices WHERE id IN (${old})`, cut, ...part) },
      ])
      add(removed, rows)
      await round([{ store: 'notices', ids: part, count: rows.notices ?? 0 }, { store: 'notice_reads', count: rows.notice_reads ?? 0 }])
    }
    return removed
  },
}

// ---------- the Library: pending uploads after a day, the trash after 30 days ----------

function libraryCondition(ctx: JobContext) {
  const pendingCut = fixedCutoff(ctx.atMs, 'pendingUpload')
  const trashCut = fixedCutoff(ctx.atMs, 'trash')
  return {
    where: "(u.state = 'pending' AND u.created_at_ms < ?) OR EXISTS (SELECT 1 FROM library_marks m WHERE m.file_id = u.id AND m.source = 'upload' AND m.deleted_at_ms < ?)",
    params: [pendingCut, trashCut] as SqlValue[],
    cutoffs: [{ store: 'library_uploads:pending', cutoffMs: pendingCut }, { store: 'library_uploads:trash', cutoffMs: trashCut }],
  }
}

export const library: RetentionJob = {
  async plan(ctx) {
    const c = libraryCondition(ctx)
    const found = await ids(ctx.db, `SELECT u.id AS id FROM library_uploads u WHERE ${c.where} ORDER BY u.id`, c.params, ctx.limit)
    const marked = found.units.length === 0 ? 0 : await count(ctx.db, stmt(`SELECT COUNT(*) AS n FROM library_marks WHERE source = 'upload' AND file_id IN (${marks(found.units.length)})`, ...found.units))
    return { counts: { library_uploads: found.units.length, library_marks: marked, 'library/': found.units.length }, units: found.units, cutoffs: c.cutoffs, more: found.more }
  },
  async run(ctx, plan, round) {
    const c = libraryCondition(ctx)
    const removed: Record<string, number> = {}
    for (const part of chunks(plan.units, FILES_ROUND)) {
      const ups = await all<{ id: string; r2_key: string }>(ctx.db, stmt(`SELECT u.id, u.r2_key FROM library_uploads u WHERE u.id IN (${marks(part.length)}) AND (${c.where})`, ...part, ...c.params))
      if (ups.length === 0) continue
      const keys = ups.map(u => u.r2_key)
      // The object before the row.
      await deleteKeys(ctx.bucket, keys)
      const upIds = ups.map(u => u.id)
      const rows = await deleted(ctx.db, [
        { store: 'library_marks', stmt: stmt(`DELETE FROM library_marks WHERE source = 'upload' AND file_id IN (${marks(upIds.length)})`, ...upIds) },
        { store: 'library_uploads', stmt: stmt(`DELETE FROM library_uploads WHERE id IN (${marks(upIds.length)})`, ...upIds) },
      ])
      add(removed, { ...rows, 'library/': keys.length })
      await round([{ store: 'library_uploads', ids: upIds, count: rows.library_uploads ?? 0 }, { store: 'library_marks', ids: upIds, count: rows.library_marks ?? 0 }, { store: 'library/', keys, count: keys.length }])
    }
    return removed
  },
}

/** The job that serves each custom rule's store. */
export const RETENTION_JOBS: Readonly<Record<string, RetentionJob>> = {
  chats: chatCascade,
  tool_calls: toolCallsSteps,
  chat_files: chatFilesTrash,
  BrandAgent: brandAgentSteps,
  memories: forgottenMemories,
  routine_slots: routineSlots,
  notices: noticesSteps,
  library_uploads: library,
}

/** The custom stores another store's job removes, by that store: they have no job of their own. */
export const SERVED_BY: Readonly<Record<string, string>> = {
  chat_messages: 'chats',
  'sessions/': 'chats',
  'files/': 'chats',
  notice_reads: 'notices',
  library_marks: 'library_uploads',
  'library/': 'library_uploads',
}
