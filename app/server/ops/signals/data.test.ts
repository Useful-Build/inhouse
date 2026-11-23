// P8 C1's data health signals (#346 review M2). Ways they can fail, written down first:
//  1. backup_fresh reads green with no complete backup, or with one older than 26 hours (or an incomplete newer one);
//  2. retention_fresh reads green while a store has had no `done` run for 26 hours;
//  3. retention_overdue misses a row past its cutoff plus two days, or reds a row inside the slack;
//  4. a signal's detail holds anything but counts, ages and store names.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { backup } from '../../../ops/backup/backup.ts'
import { backupPartKey } from '../../db/r2-keys.ts'
import { openStores } from '../../db/stores.ts'
import { seedBrand } from '../../seed/seed.ts'
import { tables } from '../../../ops/tables/index.ts'
import { retentionPass } from '../retention-handlers.ts'
import { signals } from './index.ts'
import { OVERDUE_SLACK_MS, backupFresh, retentionFresh, retentionOverdue } from './data.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2041, 5, 1, 4, 0)
const bucket = env.FILES as R2Bucket

beforeAll(async () => {
  await seedBrand(env.DB, openStores(env), NOW - 9_000 * DAY)
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
  })
})
