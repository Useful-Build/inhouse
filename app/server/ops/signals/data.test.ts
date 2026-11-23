// P8 C1's data health signals (#346 review M2). Ways they can fail, written down first:
//  1. backup_fresh reads green with no complete backup, or with one older than 26 hours (or an incomplete newer one);
//  2. retention_fresh reads green while a store has had no `done` run for 26 hours;
//  3. retention_overdue misses a row past its cutoff plus two days, or reds a row inside the slack;
//  4. a signal's detail holds anything but counts, ages and store names.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { backup } from '../../../ops/backup/backup.ts'
import { addActivity } from '../../../ops/coverage/chat-watch-connectors/test-support.ts'
import { backupPartKey } from '../../db/r2-keys.ts'
import { openStores } from '../../db/stores.ts'
import { seedBrand } from '../../seed/seed.ts'
import type { Seeded } from '../../seed/seed.ts'
import { tables } from '../../../ops/tables/index.ts'
import { retentionPass } from '../retention-handlers.ts'
import { signals } from './index.ts'
import { OVERDUE_SLACK_MS, backupFresh, retentionFresh, retentionOverdue } from './data.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2041, 5, 1, 4, 0)
const bucket = env.FILES as R2Bucket
let seeded: Seeded

beforeAll(async () => {
  seeded = await seedBrand(env.DB, openStores(env), NOW - 9_000 * DAY)
})

describe('the data signals', () => {
  it('are registered on the health route', () => {
    expect(signals.map(s => s.name)).toEqual(expect.arrayContaining(['backup_fresh', 'retention_fresh', 'retention_overdue']))
  })

  it('backup_fresh is red with no complete backup, green within 26 hours of the newest, red after', async () => {
    expect(await backupFresh(env.DB, bucket, NOW)).toEqual({ ok: false, detail: 'no complete backup' })
    // A deployment under 26 hours old (its first migration) hasn't had its first night: green, saying so.
    expect(await backupFresh(env.DB, bucket, Date.now())).toEqual({ ok: true, detail: 'no backup yet (deployed under 26h ago)' })
    const m = await backup({ db: env.DB, bucket, nowMs: NOW })
    // A newer backup that never finished (no manifest) doesn't count.
    await bucket.put(backupPartKey('99999999T999999999Z-ffffffff', 'members', 0), '[]\n')
    expect(await backupFresh(env.DB, bucket, NOW + 3_600_000)).toMatchObject({ ok: true, detail: expect.stringMatching(/^1h old, \d+ parts$/) })
    expect((await backupFresh(env.DB, bucket, m.takenAtMs + 27 * 3_600_000)).ok).toBe(false)
  })

  it('retention_fresh is red until every store has a done run within 26 hours, and names the stale ones', async () => {
    const stores = ['activity_lines', 'today_aside']
    expect(await retentionFresh(env.DB, bucket, NOW, stores)).toEqual({ ok: false, detail: 'no run in 26h: activity_lines, today_aside' })
    const registry = stores.map(n => tables.find(t => t.name === n)!)
    await retentionPass({ db: env.DB, bucket, nowMs: NOW, requestId: 'fresh', from: 0, registry })
    // The log's entries are stamped with the wall clock: read the signal at it.
    const wall = Date.now()
    expect(await retentionFresh(env.DB, bucket, wall, stores)).toEqual({ ok: true, detail: '2 stores' })
    expect((await retentionFresh(env.DB, bucket, wall + 27 * 3_600_000, stores)).ok).toBe(false)
  })

  it('retention_overdue reds a row past its cutoff plus two days, names the store, and leaves a row inside the slack', async () => {
    const cut = NOW - 365 * DAY
    expect(await retentionOverdue(env.DB, NOW)).toEqual({ ok: true })
    await env.DB.prepare("INSERT INTO activity_lines (id, at_ms, kind, template, fields_json, source, source_key) VALUES ('a_slack', ?, 'change', 't', '{}', 'test', 'a_slack')").bind(cut - OVERDUE_SLACK_MS).run()
    expect(await retentionOverdue(env.DB, NOW)).toEqual({ ok: true })
    await env.DB.prepare("INSERT INTO activity_lines (id, at_ms, kind, template, fields_json, source, source_key) VALUES ('a_late', ?, 'change', 't', '{}', 'test', 'a_late')").bind(cut - OVERDUE_SLACK_MS - 1).run()
    expect(await retentionOverdue(env.DB, NOW)).toEqual({ ok: false, detail: 'past retention: activity_lines 1' })
    await env.DB.prepare("DELETE FROM activity_lines WHERE id IN ('a_slack', 'a_late')").run()
  })

  it.each([
    { chats: '3 months', steps: '24 months', chatAge: 93, stepAge: 395, chatGone: true, stepGone: false, late: 'chats 1' },
    { chats: '24 months', steps: '3 months', chatAge: 395, stepAge: 93, chatGone: false, stepGone: true, late: 'activity_lines 1' },
    { chats: '3 months', steps: '3 months', chatAge: 90, stepAge: 90, chatGone: false, stepGone: false, late: null },
    { chats: 'Until deleted', steps: 'Until deleted', chatAge: 900, stepAge: 900, chatGone: false, stepGone: false, late: null },
  ])('uses the saved $chats chats and $steps steps periods for $chatAge-day-old chats and $stepAge-day-old steps', async ({ chats, steps, chatAge, stepAge, chatGone, stepGone, late }) => {
    const db = env.DB
    const { settings } = openStores(env)
    const current = await settings.list('brand', 'technical')
    for (const [key, value] of [['d:chats', chats], ['d:steps', steps]]) {
      const ifRev = current.find(setting => setting.key === key)?.rev ?? 0
      const saved = await settings.write({ owner: 'brand', scope: 'technical', key, value, ifRev }, {
        actorId: seeded.members.admin, nowMs: NOW, requestId: `retention-${chatAge}-${key}`,
      })
      expect(saved).toHaveProperty('ok')
    }
    const registry = tables.filter(t => t.name === 'chats' || t.name === 'activity_lines')
    const insertChat = db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES (?, ?, 'Retention test', ?, ?, ?)")
    const atMs = NOW - chatAge * DAY
    await insertChat.bind('c_period', seeded.members.dana, atMs, atMs, null).run()
    await addActivity(db, { id: 'a_period', actor: seeded.members.dana, subject: null, atMs: NOW - stepAge * DAY })
    expect(await retentionOverdue(db, NOW)).toEqual(late === null ? { ok: true } : { ok: false, detail: `past retention: ${late}` })

    // The signal and the job both retain the independent trash rule.
    if (chats === 'Until deleted') {
      await insertChat.bind('c_trash', seeded.members.dana, NOW - 40 * DAY, NOW - 34 * DAY, NOW - 33 * DAY).run()
      expect(await retentionOverdue(db, NOW)).toEqual({ ok: false, detail: 'past retention: chats 1' })
    }
    expect(await retentionPass({ db, bucket, nowMs: NOW, requestId: 'period', from: 0, registry })).toMatchObject({ reached: 2, failed: [] })
    expect((await db.prepare("SELECT id FROM chats WHERE id IN ('c_period', 'c_trash')").all()).results).toEqual(chatGone ? [] : [{ id: 'c_period' }])
    expect(await db.prepare("SELECT id FROM activity_lines WHERE id = 'a_period'").first()).toEqual(stepGone ? null : { id: 'a_period' })
    expect(await retentionOverdue(db, NOW)).toEqual({ ok: true })
    expect(await retentionFresh(db, bucket, Date.now(), registry.map(t => t.name))).toEqual({
      ok: true, detail: steps === 'Until deleted' ? '1 stores' : '2 stores',
    })
    await db.batch([
      db.prepare("DELETE FROM chats WHERE id = 'c_period'"),
      db.prepare("DELETE FROM activity_lines WHERE id = 'a_period'"),
    ])
  })
})
