// The daily audit copy on the real migrations and the test R2 bucket. Expected objects are written out from the lines
// the test inserts. Ways it can fail:
//  1. the put succeeds and the cursor update is lost (never ran, or committed with its reply lost), new lines arrive, the
//     task reruns: a second object for the same lines, a line lost or copied into two ranges;
//  2. a range over 1,000 lines loses or repeats lines across pages, or comes out of order;
//  3. tomorrow's task isn't ensured.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { auditCopy, copyAuditLog } from './audit-copy.ts'
import type { DueTask, Scheduler, TaskContext } from './do/brand-agent/scheduler.ts'

const db = env.DB
const files = env.FILES
const DAY1 = Date.UTC(2026, 10, 20, 2, 0)
const DAY2 = Date.UTC(2026, 10, 21, 2, 0)
let base = 0

async function line(action: string, atMs: number, req: string) {
  await db.prepare("INSERT INTO audit_log (at_ms, actor_id, action, args_json, req_id) VALUES (?, 'm_system', ?, '{}', ?)").bind(atMs, action, req).run()
}
const json = (id: number, action: string, atMs: number, req: string) =>
  `{"id":${id},"at_ms":${atMs},"actor_id":"m_system","action":"${action}","target_kind":null,"target_id":null,"args_json":"{}","req_id":"${req}"}`
async function objects(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const o of (await files.list({ prefix: 'audit-copy/' })).objects) out[o.key] = await (await files.get(o.key))!.text()
  return out
}

beforeEach(async () => {
  for (const o of (await files.list({ prefix: 'audit-copy/' })).objects) await files.delete(o.key)
  base = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM audit_log').first<{ m: number }>())!.m
  await db.prepare('DELETE FROM audit_copy_state').run()
  await db.prepare('INSERT INTO audit_copy_state (id, last_id, at_ms) VALUES (1, ?, 0)').bind(base).run()
})

describe('the daily audit copy', () => {
  it('a lost cursor update, new lines, a rerun: one object for the persisted range, the new lines in the next (failure 1)', async () => {
    await line('test.one', 1_000, 'rq1')
    await line('test.two', 2_000, 'rq2')
    await line('test.three', 3_000, 'rq3')
    await expect(copyAuditLog({ db, files, nowMs: DAY1, beforeAdvance: () => { throw new Error('fixture: the cursor update never ran') } })).rejects.toThrow()
    await line('test.four', 4_000, 'rq4')
    await line('test.five', 5_000, 'rq5')
    const written = await copyAuditLog({ db, files, nowMs: DAY2 })
    const first = `audit-copy/2026-11-20/${base + 1}-${base + 3}.jsonl`
    const second = `audit-copy/2026-11-21/${base + 4}-${base + 5}.jsonl`
    expect(written.map(w => w.key)).toEqual([first, second])
    expect(await objects()).toEqual({
      [first]: `${json(base + 1, 'test.one', 1_000, 'rq1')}\n${json(base + 2, 'test.two', 2_000, 'rq2')}\n${json(base + 3, 'test.three', 3_000, 'rq3')}\n`,
      [second]: `${json(base + 4, 'test.four', 4_000, 'rq4')}\n${json(base + 5, 'test.five', 5_000, 'rq5')}\n`,
    })
    expect(await db.prepare('SELECT last_id, pending_from FROM audit_copy_state').first()).toEqual({ last_id: base + 5, pending_from: null })
  })

  it('a cursor update that committed with its reply lost: the rerun copies nothing twice (failure 1)', async () => {
    await line('test.six', 6_000, 'rq6')
    await expect(copyAuditLog({ db, files, nowMs: DAY1, afterAdvance: () => { throw new Error('fixture: the reply was lost') } })).rejects.toThrow()
    expect(await copyAuditLog({ db, files, nowMs: DAY2 })).toEqual([])
    expect(Object.keys(await objects())).toEqual([`audit-copy/2026-11-20/${base + 1}-${base + 1}.jsonl`])
  })

  it('a range of 1,005 lines comes out whole and in order across pages of 1,000 (failure 2)', async () => {
    const stmts = Array.from({ length: 1_005 }, (_, i) =>
      db.prepare("INSERT INTO audit_log (at_ms, actor_id, action, args_json, req_id) VALUES (?, 'm_system', 'test.bulk', '{}', ?)").bind(i, `b${i}`))
    await db.batch(stmts)
    const [w] = await copyAuditLog({ db, files, nowMs: DAY1 })
    expect(w).toMatchObject({ from: base + 1, to: base + 1_005, lines: 1_005 })
    const body = (await objects())[w.key].trimEnd().split('\n').map(l => JSON.parse(l) as { id: number; req_id: string })
    expect(body.map(l => l.id)).toEqual(Array.from({ length: 1_005 }, (_, i) => base + 1 + i))
    expect(body[1_004].req_id).toBe('b1004')
  })

  it('the task ensures tomorrow\'s copy (failure 3)', async () => {
    const ensured: Parameters<Scheduler['ensure']>[0][] = []
    const scheduler: Scheduler = { schedule: () => undefined, ensure: t => void ensured.push(t), cancel: () => undefined }
    const task: DueTask = { id: 'audit-copy:2026-11-30', kind: 'audit-copy', gen: 1, dueAtMs: DAY1, payload: null, attempts: 0 }
    expect(await auditCopy(task, { nowMs: DAY1, env, scheduler } as unknown as TaskContext)).toEqual({ done: true })
    expect(ensured).toEqual([{ id: 'audit-copy:2026-12-01', kind: 'audit-copy', dueAtMs: Date.UTC(2026, 11, 1, 2, 0) }])
  })
})
