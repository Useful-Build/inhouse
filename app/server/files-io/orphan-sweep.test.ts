// The chat file orphan sweep on the real migrations, D1 and R2 (Workers pool). Expected values are literals written here.
// R2's `uploaded` is real time, so the clock is the injected `nowMs`, set relative to a `T0` taken before the puts
// (60 s of margin each way); row ages are D1 values the test writes. Ways it can fail, written down first:
//  1. an orphan object (no row) is kept past the safety age, or deleted before it (an in-flight upload swept);
//  2. a file with a row is deleted: saved, superseded, an attachment, or one in a trashed chat before its purge;
//  3. a pending row past the window stays (its slot and object leak), or one inside it, or one whose confirm is still
//     queued, is removed; a confirm that wins the race loses its file;
//  4. keys outside `files/` (sessions, photos, the audit copy) are touched;
//  5. a pass is unbounded, or loses its place between passes, or a second pass changes anything;
//  6. the task isn't a registered seed, or reschedules wrongly.
import { env } from 'cloudflare:workers'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DueTask, TaskContext } from '../do/brand-agent/scheduler.ts'
import { registrySeeds } from '../do/brand-agent/scheduler.ts'
import { taskHandlers } from '../do/brand-agent/tasks/index.ts'
import { inAgent } from '../testing/brand-agent/core-harness.ts'
import { chatFileSweep, CONTINUE_MS, namedSql, PENDING_SQL, PENDING_PAGE, PENDING_PAGES, SAFETY_AGE_MS, SCAN_EVERY_MS, SCAN_PAGE, SCAN_PAGES, SWEEP_TASK_ID, sweepOnce } from './orphan-sweep.ts'

const db = env.DB
const bucket = env.FILES
const MIN = 60_000
const AGE = 60 * MIN
let T0 = 0
let n = 0
const noConfirm = () => false

beforeAll(async () => {
  await db.prepare("INSERT OR IGNORE INTO members (id, kind, role, status, name, email_norm, created_at_ms) VALUES ('m_sweep_owner', 'person', 'member', 'active', 'Ada', 'sweep-owner@example.com', 1)").run()
})
beforeEach(async () => {
  await db.prepare('DELETE FROM chat_files').run()
  for (let cursor: string | undefined; ;) {
    const l = await bucket.list({ cursor })
    if (l.objects.length > 0) await bucket.delete(l.objects.map(o => o.key))
    if (!l.truncated) break
    cursor = l.cursor
  }
  T0 = Date.now()
})

const newChat = async (deletedAtMs: number | null = null) => {
  const id = `chat-sweep-${++n}`
  await db.prepare("INSERT INTO chats (id, owner_id, title, deleted_at_ms, created_at_ms, last_at_ms) VALUES (?, 'm_sweep_owner', 'Files', ?, 1, 1)").bind(id, deletedAtMs).run()
  return id
}
const put = (key: string) => bucket.put(key, 'x')
const keys = async (prefix = '') => {
  const out: string[] = []
  for (let cursor: string | undefined; ;) {
    const l = await bucket.list({ prefix, cursor })
    out.push(...l.objects.map(o => o.key))
    if (!l.truncated) return out.sort()
    cursor = l.cursor
  }
}
const row = (o: { id: string; chat: string; key: string; state: 'pending' | 'saved'; createdAtMs: number; turn?: string | null; replacedAtMs?: number | null; kind?: 'input' | 'output' }) =>
  db.prepare(`INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, turn_id, created_by, created_at_ms, replaced_at_ms)
              VALUES (?, ?, ?, ?, 'a.txt', 'text/plain', 1, 'h', ?, ?, ?, NULL, ?, ?)`)
    .bind(o.id, o.chat, o.kind ?? 'output', `outputs/${o.id}.txt`, o.key, o.state, o.turn ?? null, o.createdAtMs, o.replacedAtMs ?? null).run()
const rows = async () => (await db.prepare('SELECT id FROM chat_files ORDER BY id').all<{ id: string }>()).results.map(r => r.id)
const sweep = (nowMs: number, o: { cursor?: string | null; confirmQueued?: (t: string) => boolean } = {}) =>
  sweepOnce({ db, bucket, nowMs, confirmQueued: o.confirmQueued ?? noConfirm, cursor: o.cursor })
const OLD = () => T0 + AGE + MIN
const YOUNG = () => T0 + AGE - MIN

describe('the safety age', () => {
  it('is 60 minutes: the 45-minute run token plus 15 (failure 1)', () => {
    expect(SAFETY_AGE_MS).toBe(3_600_000)
  })

  it('an orphan past it is deleted; a younger one is kept (failure 1)', async () => {
    await put('files/c1/f_orphan')
    expect(await sweep(YOUNG())).toMatchObject({ scanned: 1, orphansDeleted: 0, cursor: null })
    expect(await keys()).toEqual(['files/c1/f_orphan'])
    expect(await sweep(OLD())).toMatchObject({ scanned: 1, orphansDeleted: 1, cursor: null })
    expect(await keys()).toEqual([])
  })
})

describe('files with a row are never touched (failure 2)', () => {
  it('saved, superseded, attachment and trashed-chat files stay, however old', async () => {
    const live = await newChat()
    const trashed = await newChat(T0 - 5 * 86_400_000)
    await put('files/live/saved'); await row({ id: 'r_saved', chat: live, key: 'files/live/saved', state: 'saved', createdAtMs: 1, turn: 't1' })
    await put('files/live/old'); await row({ id: 'r_old', chat: live, key: 'files/live/old', state: 'saved', createdAtMs: 1, turn: 't0', replacedAtMs: 2 })
    await put('files/live/input'); await row({ id: 'r_input', chat: live, key: 'files/live/input', state: 'saved', createdAtMs: 1, kind: 'input' })
    await put('files/trash/saved'); await row({ id: 'r_trash', chat: trashed, key: 'files/trash/saved', state: 'saved', createdAtMs: 1, turn: 't2' })
    await put('files/trash/pend'); await row({ id: 'r_trash_pending', chat: trashed, key: 'files/trash/pend', state: 'pending', createdAtMs: T0, turn: 't3' })
    const far = T0 + 400 * 86_400_000
    const r = await sweep(far, { confirmQueued: t => t === 't3' })
    expect(r).toMatchObject({ scanned: 5, orphansDeleted: 0, pendingExpired: 0 })
    expect(await rows()).toEqual(['r_input', 'r_old', 'r_saved', 'r_trash', 'r_trash_pending'])
    expect(await keys()).toEqual(['files/live/input', 'files/live/old', 'files/live/saved', 'files/trash/pend', 'files/trash/saved'])
  })

  it('a key another row names survives its pending duplicate expiring', async () => {
    const c = await newChat()
    await put('files/c/shared')
    await row({ id: 'r_pending', chat: c, key: 'files/c/shared', state: 'pending', createdAtMs: 1 })
    await row({ id: 'r_saved', chat: c, key: 'files/c/shared', state: 'saved', createdAtMs: 2 })
    expect(await sweep(OLD())).toMatchObject({ pendingExpired: 1, orphansDeleted: 0 })
    expect(await rows()).toEqual(['r_saved'])
    expect(await keys()).toEqual(['files/c/shared'])
  })
})

describe('pending rows (failure 3)', () => {
  it('past the window: row and object go; at the window and inside it: kept', async () => {
    const c = await newChat()
    const C = 5_000_000
    await put('files/c/p'); await row({ id: 'r_p', chat: c, key: 'files/c/p', state: 'pending', createdAtMs: C, turn: 't1' })
    // The object is young in R2's own time, so only the pending rule can remove it.
    expect(await sweep(C + AGE)).toMatchObject({ pendingExpired: 0 })
    expect(await rows()).toEqual(['r_p'])
    expect(await sweep(C + AGE + 1)).toMatchObject({ pendingExpired: 1, orphansDeleted: 0 })
    expect(await rows()).toEqual([])
    expect(await keys()).toEqual([])
  })

  it('a pending row whose confirm is still queued is kept; once drained it expires', async () => {
    const c = await newChat()
    await row({ id: 'r_q', chat: c, key: 'files/c/q', state: 'pending', createdAtMs: 1, turn: 't_queued' })
    expect(await sweep(OLD(), { confirmQueued: t => t === 't_queued' })).toMatchObject({ pendingExpired: 0 })
    expect(await rows()).toEqual(['r_q'])
    expect(await sweep(OLD())).toMatchObject({ pendingExpired: 1 })
    expect(await rows()).toEqual([])
  })

  it('a confirm that lands between the read and the delete keeps its file, row and object (the race)', async () => {
    const c = await newChat()
    await put('files/c/race'); await row({ id: 'r_race', chat: c, key: 'files/c/race', state: 'pending', createdAtMs: 1, turn: 't_r' })
    // The confirm commits right after the sweep reads its candidates.
    const racing = new Proxy(db, { get: (t, k) => k !== 'prepare' ? Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k) : (q: string) => {
      const st = t.prepare(q)
      if (!q.includes("state = 'pending' AND created_at_ms")) return st
      return { bind: (...a: unknown[]) => ({ all: async () => { const r = await st.bind(...a).all(); await t.prepare("UPDATE chat_files SET state = 'saved' WHERE id = 'r_race'").run(); return r } }) }
    } }) as D1Database
    expect(await sweepOnce({ db: racing, bucket, nowMs: OLD(), confirmQueued: noConfirm })).toMatchObject({ pendingExpired: 0, orphansDeleted: 0 })
    expect(await rows()).toEqual(['r_race'])
    expect(await keys()).toEqual(['files/c/race'])
  })

  it('a reserved slot with no object (the PUT died before its put) expires too', async () => {
    const c = await newChat()
    await row({ id: 'r_nobytes', chat: c, key: 'files/c/none', state: 'pending', createdAtMs: 1 })
    expect(await sweep(OLD())).toMatchObject({ pendingExpired: 1 })
    expect(await rows()).toEqual([])
  })
})

describe('other prefixes (failure 4)', () => {
  it('sessions, photos and the audit copy are never listed or deleted', async () => {
    for (const k of ['sessions/c/s/h/m/0.json', 'photos/m_1/abc', 'audit-copy/2026-11-20/1-9.jsonl', 'files2/x', 'x/files/y']) await put(k)
    await put('files/c/orphan')
    expect(await sweep(OLD())).toMatchObject({ scanned: 1, orphansDeleted: 1 })
    expect(await keys()).toEqual(['audit-copy/2026-11-20/1-9.jsonl', 'files2/x', 'photos/m_1/abc', 'sessions/c/s/h/m/0.json', 'x/files/y'])
  })
})

describe('bounds and idempotence (failure 5)', () => {
  it('a pass lists at most SCAN_PAGES x SCAN_PAGE keys, resumes from its cursor, and a second pass is a no-op', async () => {
    expect(SCAN_PAGE * SCAN_PAGES).toBe(500)
    const total = 520
    for (let i = 0; i < total; i += 50) await Promise.all(Array.from({ length: Math.min(50, total - i) }, (_, j) => put(`files/c/f${String(i + j).padStart(4, '0')}`)))
    const first = await sweep(OLD())
    expect(first).toMatchObject({ scanned: 500, orphansDeleted: 500 })
    expect(first.cursor).not.toBeNull()
    expect((await keys()).length).toBe(20)
    const second = await sweep(OLD(), { cursor: first.cursor })
    expect(second).toMatchObject({ scanned: 20, orphansDeleted: 20, cursor: null })
    expect(await keys()).toEqual([])
    expect(await sweep(OLD())).toEqual({ scanned: 0, orphansDeleted: 0, pendingExpired: 0, cursor: null, pendingMore: false })
  })

  it('a pass reads at most PENDING_PAGES x PENDING_PAGE pending rows and says more are left', async () => {
    expect(PENDING_PAGE * PENDING_PAGES).toBe(500)
    const c = await newChat()
    const stmts = Array.from({ length: 520 }, (_, i) => db.prepare(
      `INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, turn_id, created_by, created_at_ms)
       VALUES (?, ?, 'output', ?, 'a.txt', '', 0, '', ?, 'pending', NULL, NULL, ?)`).bind(`r${String(i).padStart(4, '0')}`, c, `outputs/${i}`, `files/c/p${i}`, 1 + i))
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))
    const first = await sweep(OLD())
    expect(first).toMatchObject({ pendingExpired: 500, pendingMore: true })
    expect((await rows()).length).toBe(20)
    expect(await sweep(OLD())).toMatchObject({ pendingExpired: 20, pendingMore: false })
    expect(await rows()).toEqual([])
    expect(await sweep(OLD())).toMatchObject({ pendingExpired: 0, orphansDeleted: 0 })
  })

  it('pending rows kept by a queued confirm do not starve the rows behind them', async () => {
    const c = await newChat()
    const stmts = Array.from({ length: 150 }, (_, i) => db.prepare(
      `INSERT INTO chat_files (id, chat_id, kind, path, name, content_type, bytes, sha256, r2_key, state, turn_id, created_by, created_at_ms)
       VALUES (?, ?, 'output', ?, 'a.txt', '', 0, '', ?, 'pending', ?, NULL, ?)`).bind(`s${String(i).padStart(4, '0')}`, c, `outputs/${i}`, `files/c/s${i}`, i < 120 ? 'busy' : 'free', 1 + i))
    for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50))
    expect(await sweep(OLD(), { confirmQueued: t => t === 'busy' })).toMatchObject({ pendingExpired: 30 })
    expect((await rows()).length).toBe(120)
  })
})

describe('the registered task (failure 6)', () => {
  const ctxAt = (nowMs: number, scheduled: unknown[]) => ({
    nowMs, env, sql: { exec: () => ({ toArray: () => [] }) },
    scheduler: { schedule: (t: unknown) => void scheduled.push(t), ensure: () => undefined, cancel: () => undefined },
  }) as unknown as TaskContext
  const task = (payload: unknown = null): DueTask => ({ id: SWEEP_TASK_ID, kind: SWEEP_TASK_ID, gen: 1, dueAtMs: 0, payload, attempts: 0 })

  it('is in the registry and declares its seed', () => {
    expect(taskHandlers['chat-file-sweep']).toBe(chatFileSweep)
    expect(registrySeeds(taskHandlers)).toContainEqual({ id: 'chat-file-sweep', kind: 'chat-file-sweep' })
  })

  it('a finished scan comes again in 6 hours; an unfinished one soon, carrying its cursor, and resumes from it', async () => {
    expect([SCAN_EVERY_MS, CONTINUE_MS]).toEqual([21_600_000, 60_000])
    await put('files/c/o1')
    const done: unknown[] = []
    expect(await chatFileSweep(task(), ctxAt(OLD(), done))).toEqual({ done: true })
    expect(done).toEqual([{ id: 'chat-file-sweep', kind: 'chat-file-sweep', dueAtMs: OLD() + 21_600_000 }])
    expect(await keys()).toEqual([])

    for (let i = 0; i < 520; i += 50) await Promise.all(Array.from({ length: Math.min(50, 520 - i) }, (_, j) => put(`files/c/g${String(i + j).padStart(4, '0')}`)))
    const more: { payload?: { cursor: string } }[] = []
    await chatFileSweep(task(), ctxAt(OLD(), more))
    expect(more).toHaveLength(1)
    expect(more[0]).toMatchObject({ id: 'chat-file-sweep', dueAtMs: OLD() + 60_000 })
    expect(typeof more[0].payload?.cursor).toBe('string')
    const last: unknown[] = []
    await chatFileSweep(task(more[0].payload), ctxAt(OLD(), last))
    expect(last).toEqual([{ id: 'chat-file-sweep', kind: 'chat-file-sweep', dueAtMs: OLD() + 21_600_000 }])
    expect(await keys()).toEqual([])
  })

  it('reads the queued confirms from the object, so a queued turn keeps its pending row', async () => {
    const c = await newChat()
    await row({ id: 'r_h', chat: c, key: 'files/c/h', state: 'pending', createdAtMs: 1, turn: 't_h' })
    const ctx = { ...ctxAt(OLD(), []), sql: { exec: (_q: string, id: string) => ({ toArray: () => (id === 't_h' ? [{}] : []) }) } } as unknown as TaskContext
    await chatFileSweep(task(), ctx)
    expect(await rows()).toEqual(['r_h'])
  })
})

describe('0121 indexes and the key invariant (review of #199)', () => {
  const plan = async (sql: string, ...binds: unknown[]) =>
    (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results.map(r => r.detail)

  it('the key lookup uses chat_files_r2_key and the pending page uses chat_files_pending, neither scans the table', async () => {
    const named = await plan(namedSql(3), 'a', 'b', 'c')
    expect(named.join(' | ')).toMatch(/SEARCH chat_files USING (COVERING )?INDEX chat_files_r2_key/)
    expect(named.some(d => /^SCAN chat_files/.test(d))).toBe(false)
    const pending = await plan(PENDING_SQL, 1, -1, -1, '', 100)
    expect(pending.join(' | ')).toContain('chat_files_pending')
    expect(pending.some(d => /^SCAN chat_files$/.test(d))).toBe(false)
    expect(pending.some(d => d.includes('USE TEMP B-TREE'))).toBe(false)
  })

  it('only the store and the egress build a files/ key: a new caller fails here until it is checked against the sweep', () => {
    const sources = import.meta.glob<string>(['../**/*.ts', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true })
    const callers = Object.entries(sources).filter(([f, text]) => !f.endsWith('/db/r2-keys.ts') && /\bchatFileKey\b|CHAT_FILES_PREFIX|['"`]files\//.test(text)).map(([f]) => f.replace(/^\.\.?\//, '').replace(/^(orphan-sweep|store)\.ts$/, 'files-io/$1.ts')).sort()
    expect(callers).toEqual(['egress/files.ts', 'files-io/orphan-sweep.ts', 'files-io/store.ts'])
  })

  it('the handler reads a real turn_effects row from the BrandAgent object', () => inAgent(async h => {
    const c = await newChat()
    await row({ id: 'r_real', chat: c, key: 'files/c/real', state: 'pending', createdAtMs: 1, turn: 't_real' })
    await row({ id: 'r_free', chat: c, key: 'files/c/free', state: 'pending', createdAtMs: 2, turn: 't_free' })
    h.sql.exec("INSERT INTO turn_effects (turn_id, seq, kind, json) VALUES ('t_real', 1, 'file', '{}')")
    const ctx = { nowMs: OLD(), env, sql: h.sql, scheduler: { schedule: () => undefined, ensure: () => undefined, cancel: () => undefined } } as unknown as TaskContext
    await chatFileSweep({ id: SWEEP_TASK_ID, kind: SWEEP_TASK_ID, gen: 1, dueAtMs: 0, payload: null, attempts: 0 }, ctx)
    expect(await rows()).toEqual(['r_real'])
  }))
})
