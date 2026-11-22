// Retention with a pinned clock (P8 acceptance 1, decision Q3). Ways it can fail, written down first:
//  1. a row at or after the cutoff goes, or one strictly before it stays (D1 by its age column, R2 by `uploaded`);
//  2. it touches a store that isn't `retention_period` (the audit log above all), or another store's rows;
//  3. the dry run writes something, or counts other than an independent count;
//  4. the run takes a new clock instead of the plan's cutoff, or runs without a plan;
//  5. the log entry misses a removed id or the cutoff, or the result hides a count that changed since the plan;
//  6. an unknown store, a period for a non-retention store or a missing period or rule passes silently.
// The test brings its own `retention_period` stores: a fixture table and prefix with their entries and rules, passed
// in as arguments beside P2's and P8's entries. C1's stores (P3 and P4's) have their own rules and tests
// (rules.test.ts); their custom rules refuse to plan until C1's jobs land, so the real registry refuses by name.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import { listDeletionLog } from '../delete/log.ts'
import { recordingDb, snapshotAll, token, withoutLog, writesAudit } from '../delete/test-support.ts'
import type { Snapshot } from '../delete/test-support.ts'
import { coreTables } from '../tables/core.ts'
import { tables } from '../tables/index.ts'
import { p8Tables } from '../tables/p8.ts'
import type { TableEntry } from '../tables/types.ts'
import { planRetention, runRetention } from './retention.ts'
import type { RetentionDeps, RetentionPlan } from './retention.ts'
import { periodsFor } from './rules.ts'
import type { RetentionRule } from './rules.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const DAY = 86_400_000
const BASE = 1_800_000_000_000
const FIXTURE_PREFIX = 'retention-fixture/'
const registry: TableEntry[] = [
  ...coreTables,
  ...p8Tables,
  { kind: 'd1', name: 'retention_fixture', retention: 'retention_period', personKeys: [], export: false },
  { kind: 'r2', name: FIXTURE_PREFIX, retention: 'retention_period', personKeys: [], export: false },
]
const rules: Record<string, RetentionRule> = { retention_fixture: { kind: 'd1', ageColumn: 'at_ms', idColumn: 'id' }, [FIXTURE_PREFIX]: { kind: 'r2' } }
// The log's write clock: moving on every read, so each run's entries sort after every earlier run's and a case can list
// only its own run's entries (after the last key it saw) instead of reading the whole log.
let wall = BASE + 1_000_000_000
const deps = (nowMs: number, over: Partial<RetentionDeps> = {}): RetentionDeps => ({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs }, clock: () => ++wall, registry, rules, ...over })
/** The last deletion-log key in a snapshot: a run's own entries list after it. */
const lastLogKey = (s: Snapshot): string | undefined => Object.keys(s.r2).filter(k => k.startsWith('deletion-log/')).sort().at(-1)
// Each case snapshots and lists the log, which grows with every case: by etag and from a watermark, so a case's cost
// doesn't grow with the cases before it.
const cheap = { logBodies: false }

beforeAll(async () => {
  await seedBrand(db, openStores(env), BASE)
  await db.prepare('CREATE TABLE retention_fixture (id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, note TEXT)').run()
})

describe('the D1 cutoff (failures 1 to 5, property)', () => {
  // Ages relative to the cutoff, biased to the edge: exactly at it, a millisecond either side, or anywhere.
  const offset = fc.oneof(fc.constant(0), fc.constant(-1), fc.constant(1), fc.integer({ min: -100 * DAY, max: 100 * DAY }))
  test.prop([fc.array(offset, { maxLength: 12 }), fc.integer({ min: 1, max: 400 }), fc.integer({ min: 0, max: 10 * DAY }), fc.integer({ min: 1, max: 5 })], { numRuns: 60 })(
    'removes exactly the rows strictly older than the cutoff, in bounded rounds, logs them, and nothing else', async (offsets, days, shift, roundSize) => {
      const nowMs = BASE + shift
      const cutoff = nowMs - days * DAY
      for (const o of offsets) await db.prepare('INSERT INTO retention_fixture (id, at_ms, note) VALUES (?, ?, ?)').bind(`r${token()}`, cutoff + o, 'x').run()
      const before = await snapshotAll(db, bucket, cheap)
      const rec = recordingDb(db)
      const d = deps(nowMs, { db: rec.db })
      const plan = await planRetention(d, { periods: { retention_fixture: days, [FIXTURE_PREFIX]: days } })
      expect(await snapshotAll(db, bucket, cheap), 'the dry run writes nothing').toEqual(before)
      const old = before.d1.retention_fixture.filter(r => (r.at_ms as number) < cutoff)
      expect(plan.cutoffs).toContainEqual({ store: 'retention_fixture', cutoffMs: cutoff })
      expect(plan.counts.retention_fixture).toBe(old.length)

      // A later clock on the run's deps changes nothing: the plan's cutoff rules.
      const result = await runRetention(deps(nowMs + 50 * DAY, { db: rec.db }), plan, { roundSize })
      expect(rec.sql.filter(writesAudit)).toEqual([])
      expect(result.removed.retention_fixture).toBe(old.length)
      expect(result.differences).toEqual([])
      const after = await snapshotAll(db, bucket, cheap)
      expect(after.d1.retention_fixture).toEqual(before.d1.retention_fixture.filter(r => (r.at_ms as number) >= cutoff))
      for (const t of Object.keys(before.d1)) if (t !== 'retention_fixture') expect(after.d1[t], t).toEqual(before.d1[t])
      expect(withoutLog(after).r2).toEqual(withoutLog(before).r2)
      // Every entry after the last one seen before is this run's, and the log gained nothing else.
      const log = await listDeletionLog(bucket, { after: lastLogKey(before) })
      expect(log.every(e => e.entry.runId === result.runId)).toBe(true)
      expect(Object.keys(after.r2).filter(k => !(k in before.r2))).toEqual(log.map(e => e.key))
      // start, one progress entry per non-empty round of at most roundSize ids, then done with the totals.
      const rounds = Math.ceil(old.length / roundSize)
      expect(log.map(e => e.entry.phase)).toEqual(['start', ...Array<string>(rounds).fill('progress'), 'done'])
      expect(log.map(e => e.entry.step)).toEqual(log.map((_, i) => i))
      const progress = log.filter(e => e.entry.phase === 'progress').map(e => e.entry.removed!)
      for (const r of progress) expect(r).toEqual([expect.objectContaining({ store: 'retention_fixture', count: r[0].ids!.length })])
      for (const r of progress) expect(r[0].ids!.length).toBeLessThanOrEqual(roundSize)
      expect(progress.flatMap(r => r[0].ids!).sort()).toEqual(old.map(r => r.id as string).sort())
      const done = log.at(-1)!.entry
      expect(done.cutoffs).toContainEqual({ store: 'retention_fixture', cutoffMs: cutoff })
      expect(done.removed).toContainEqual({ store: 'retention_fixture', count: old.length })
    },
  )

  it('reports, without refusing, a count that changed between plan and run', async () => {
    const nowMs = BASE + 20 * DAY
    const plan = await planRetention(deps(nowMs), { periods: { retention_fixture: 1, [FIXTURE_PREFIX]: 1 } })
    await db.prepare('INSERT INTO retention_fixture (id, at_ms) VALUES (?, ?)').bind(`late${token()}`, nowMs - 2 * DAY).run()
    const r = await runRetention(deps(nowMs), plan)
    expect(r.differences).toEqual([{ store: 'retention_fixture', planned: plan.counts.retention_fixture, removed: plan.counts.retention_fixture + 1 }])
  })
})

describe('the R2 cutoff (failure 1)', () => {
  // R2 stamps `uploaded` itself, so the clock is pinned around the objects' own times: the cutoff is one object's
  // uploaded time, and exactly the objects uploaded strictly before it go.
  test.prop([fc.integer({ min: 1, max: 8 }), fc.nat(), fc.integer({ min: 1, max: 90 })], { numRuns: 15 })('removes exactly the objects uploaded strictly before the cutoff', async (n, pick, days) => {
    for (let i = 0; i < n; i++) await bucket.put(`${FIXTURE_PREFIX}${token()}`, `bytes${i}`)
    const objs = (await bucket.list({ prefix: FIXTURE_PREFIX })).objects
    const cutoff = objs[pick % objs.length].uploaded.getTime()
    const before = await snapshotAll(db, bucket, cheap)
    const plan = await planRetention(deps(cutoff + days * DAY), { periods: { retention_fixture: 100_000, [FIXTURE_PREFIX]: days } })
    const old = objs.filter(o => o.uploaded.getTime() < cutoff).map(o => o.key).sort()
    expect(plan.counts[FIXTURE_PREFIX]).toBe(old.length)
    const r = await runRetention(deps(cutoff + days * DAY), plan)
    expect(r.removed[FIXTURE_PREFIX]).toBe(old.length)
    const after = withoutLog(await snapshotAll(db, bucket, cheap))
    expect(after.r2).toEqual(Object.fromEntries(Object.entries(withoutLog(before).r2).filter(([k]) => !old.includes(k))))
    const log = await listDeletionLog(bucket, { after: lastLogKey(before) })
    expect(log.every(e => e.entry.runId === r.runId)).toBe(true)
    const logged = log.filter(e => e.entry.phase === 'progress').flatMap(e => e.entry.removed!.flatMap(x => (x.store === FIXTURE_PREFIX ? x.keys! : [])))
    expect(logged.sort()).toEqual(old)
    expect(log.at(-1)!.entry.removed).toContainEqual({ store: FIXTURE_PREFIX, count: old.length })
  })
})

describe('what retention refuses (failures 2, 4, 6)', () => {
  it('throws by name on a period for the audit log or any non-retention store, an unknown store, a missing period or rule', async () => {
    const both = { retention_fixture: 30, [FIXTURE_PREFIX]: 30 }
    const before = await snapshotAll(db, bucket)
    await expect(planRetention(deps(BASE), { periods: { ...both, audit_log: 30 } })).rejects.toThrow(/audit_log/)
    for (const s of ['members', 'settings', 'support_grants', 'photos/', 'backups/', 'deletion-log/']) await expect(planRetention(deps(BASE), { periods: { ...both, [s]: 30 } })).rejects.toThrow(s)
    await expect(planRetention(deps(BASE), { periods: { ...both, nowhere: 30 } })).rejects.toThrow(/nowhere/)
    await expect(planRetention(deps(BASE), { periods: { retention_fixture: 30 } })).rejects.toThrow(FIXTURE_PREFIX)
    await expect(planRetention(deps(BASE), { periods: { ...both, retention_fixture: 0 } })).rejects.toThrow(/retention_fixture/)
    // The rounds delete by idColumn, so a rule whose idColumn isn't the primary key is refused at plan.
    await expect(planRetention(deps(BASE, { rules: { ...rules, retention_fixture: { kind: 'd1', ageColumn: 'at_ms', idColumn: 'note' } } }), { periods: both })).rejects.toThrow(/not its primary key/)
    await expect(planRetention(deps(BASE, { rules: { [FIXTURE_PREFIX]: { kind: 'r2' } } }), { periods: both })).rejects.toThrow(/no rule for d1 store retention_fixture/)
    expect(await snapshotAll(db, bucket)).toEqual(before)
  })

  it('runs only from a plan made by planRetention', async () => {
    const forged: RetentionPlan = { atMs: BASE, cutoffs: [], counts: {}, targets: [] }
    await expect(runRetention(deps(BASE), forged)).rejects.toThrow(/only from a plan/)
  })

  it('on P2\'s and P8\'s stores, plans nothing; on the real registry, refuses C1\'s custom rules by name', async () => {
    const at = { actorId: SYSTEM_MEMBER_ID, requestId: 'r', nowMs: BASE }
    const plan = await planRetention({ db, bucket, at, registry: [...coreTables, ...p8Tables] }, { periods: {} })
    expect(plan.counts).toEqual({})
    expect(plan.cutoffs).toEqual([])
    await expect(planRetention({ db, bucket, at }, { periods: periodsFor(tables) })).rejects.toThrow(/rule is custom/)
  })
})
