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
import { FRESH_MS, OVERDUE_SLACK_MS, backupFresh, retentionFresh, retentionOverdue } from './data.ts'

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

  it('retention clears overdue orphaned chat marks and leaves unexpired ones', async () => {
    const db = env.DB
    const cutoff = NOW - 30 * DAY
    const mark = db.prepare("INSERT INTO library_marks (file_id, source, deleted_at_ms) VALUES (?, 'chat', ?)")
    await db.batch([mark.bind('f_orphan_expired', cutoff - OVERDUE_SLACK_MS - 1), mark.bind('f_orphan_current', cutoff)])
    expect(await retentionOverdue(db, NOW)).toEqual({ ok: false, detail: 'past retention: chat_files 1' })
    const registry = tables.filter(t => t.name === 'chat_files')
    expect(await retentionPass({ db, bucket, nowMs: NOW, requestId: 'orphan-trash', from: 0, registry })).toMatchObject({ reached: 1, failed: [] })
    expect(await retentionOverdue(db, NOW)).toEqual({ ok: true })
    const marks = await db.prepare("SELECT file_id FROM library_marks WHERE file_id IN ('f_orphan_expired', 'f_orphan_current')").all()
    expect(marks.results).toEqual([{ file_id: 'f_orphan_current' }])
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
        actorId: seeded.members.admin, nowMs: NOW - FRESH_MS, requestId: `retention-${chatAge}-${key}`,
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

  it.each(['d:chats', 'd:steps'])('gives a shortened %s one nightly pass before reporting overdue data', async key => {
    const db = env.DB
    const { settings } = openStores(env)
    const current = (await settings.list('brand', 'technical')).find(setting => setting.key === key)
    const saved = await settings.write({ owner: 'brand', scope: 'technical', key, value: '3 months', ifRev: current?.rev ?? 0 }, {
      actorId: seeded.members.admin, nowMs: NOW, requestId: `shorten-${key}`,
    })
    expect(saved).toHaveProperty('ok')

    const age = NOW - 120 * DAY
    const chat = db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES (?, ?, 'Retention test', ?, ?, ?)")
    if (key === 'd:chats') await chat.bind('c_grace', seeded.members.dana, age, age, null).run()
    else await addActivity(db, { id: 'a_grace', actor: seeded.members.dana, subject: null, atMs: age })
    expect(await retentionOverdue(db, NOW)).toEqual({ ok: true })
    expect(await retentionOverdue(db, NOW + FRESH_MS - 1)).toEqual({ ok: true })

    // An expired trashed chat still goes red during a grace window.
    await chat.bind('c_grace_trash', seeded.members.dana, age, NOW, NOW - 33 * DAY).run()
    expect(await retentionOverdue(db, NOW + 1)).toEqual({ ok: false, detail: 'past retention: chats 1' })
    await db.prepare("DELETE FROM chats WHERE id = 'c_grace_trash'").run()

    const store = key === 'd:chats' ? 'chats' : 'activity_lines'
    expect(await retentionOverdue(db, NOW + FRESH_MS)).toEqual({ ok: false, detail: `past retention: ${store} 1` })
    const registry = tables.filter(t => t.name === store)
    expect(await retentionPass({ db, bucket, nowMs: NOW + FRESH_MS, requestId: 'grace', from: 0, registry })).toMatchObject({ reached: 1, failed: [] })
    expect(await retentionOverdue(db, NOW + FRESH_MS)).toEqual({ ok: true })
  })

  it('grants no grace for lengthened or unchanged saves, and repeated saves do not extend the grace window', async () => {
    const db = env.DB
    const { settings } = openStores(env)
    await db.prepare("DELETE FROM library_marks WHERE file_id = 'f_orphan_current'").run()
    await db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key IN ('d:chats', 'd:steps')").run()
    const revOf = async (key: 'd:chats' | 'd:steps') => (await settings.list('brand', 'technical')).find(s => s.key === key)?.rev ?? 0
    const save = async (key: 'd:chats' | 'd:steps', value: string | null, nowMs: number, reqId: string) => {
      const res = await settings.write({ owner: 'brand', scope: 'technical', key, value, ifRev: await revOf(key) }, {
        actorId: seeded.members.admin, nowMs, requestId: reqId,
      })
      expect(res).toHaveProperty('ok')
    }

    // 1. Initial write equal to default ('12 months') or lengthened ('24 months') opens NO grace window.
    await save('d:chats', '12 months', NOW, 'init-default')
    await save('d:chats', '24 months', NOW + 1_000, 'len-24m')
    const old24 = NOW - 740 * DAY
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES ('c_len24', ?, 'Lengthen', ?, ?, NULL)")
      .bind(seeded.members.dana, old24, old24).run()
    expect(await retentionOverdue(db, NOW + 1_000)).toEqual({ ok: false, detail: 'past retention: chats 1' })
    await db.prepare("DELETE FROM chats WHERE id = 'c_len24'").run()

    // 2. Lengthening ('3 months' -> '6 months', after any earlier grace expired) opens NO grace window.
    await save('d:chats', '3 months', NOW + 2_000, 'short-3m')
    const afterExpire = NOW + 2 * FRESH_MS
    await save('d:chats', '6 months', afterExpire, 'len-up')
    const oldChat = afterExpire - 185 * DAY
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES ('c_len', ?, 'Lengthen', ?, ?, NULL)")
      .bind(seeded.members.dana, oldChat, oldChat).run()
    expect(await retentionOverdue(db, afterExpire)).toEqual({ ok: false, detail: 'past retention: chats 1' })
    await db.prepare("DELETE FROM chats WHERE id = 'c_len'").run()

    // 3. Saving an unchanged value (still '6 months') opens NO grace window.
    await save('d:chats', '6 months', afterExpire + 1_000, 'same-6m')
    await db.prepare("INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms, deleted_at_ms) VALUES ('c_same', ?, 'Same', ?, ?, NULL)")
      .bind(seeded.members.dana, oldChat, oldChat).run()
    expect(await retentionOverdue(db, afterExpire + 1_000)).toEqual({ ok: false, detail: 'past retention: chats 1' })
    await db.prepare("DELETE FROM chats WHERE id = 'c_same'").run()

    // 4. Repeated saves of the same shortened value do not extend an active 26-hour grace window.
    const t0 = afterExpire + 10_000
    await save('d:steps', '6 months', t0 - 2 * FRESH_MS, 'rep-init')
    await save('d:steps', '3 months', t0, 'rep-short')
    await addActivity(db, { id: 'a_rep', actor: seeded.members.dana, subject: null, atMs: t0 - 120 * DAY })
    expect(await retentionOverdue(db, t0)).toEqual({ ok: true })
    // Re-saving '3 months' halfway through the grace window must NOT push its deadline past t0 + FRESH_MS.
    await save('d:steps', '3 months', t0 + FRESH_MS / 2, 'rep-resave')
    expect(await retentionOverdue(db, t0 + FRESH_MS - 1)).toEqual({ ok: true })
    expect(await retentionOverdue(db, t0 + FRESH_MS)).toEqual({ ok: false, detail: 'past retention: activity_lines 1' })
    await db.prepare("DELETE FROM activity_lines WHERE id = 'a_rep'").run()
  })
})
