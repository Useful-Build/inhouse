// Person deletion and the deletion log (P8 acceptance 3, decision Q3). Ways it can fail, written down first:
//  1. it removes or changes anything of another person's, a brand setting or grant that only references the person,
//     an audit line, the service rows, a backup or an earlier deletion-log entry;
//  2. it leaves the person's name, email, title, subject, personal settings or photo objects (an orphan included);
//  3. the dry run writes something, or counts other than what the run then removes;
//  4. it acts on a plan made before a change (a new setting or photo nobody counted), or without a plan;
//  5. a run that fails half way can't be finished, or a re-run changes anything more;
//  6. it deletes the last active Admin, an Inhouse or service row, an unknown id, or puts a malformed id into a key;
//  7. any statement writes the audit log;
//  8. a deletion isn't in the log, or the log holds a name, an email or content, or can't be listed after a watermark;
//  9. a store registered later is skipped silently (no rule).
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { FORMER_MEMBER } from '../../server/db/members.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import type { Seeded } from '../../server/seed/seed.ts'
import { planExport, runExport } from '../export/export.ts'
import { coreTables } from '../tables/core.ts'
import { tables } from '../tables/index.ts'
import { p8Tables } from '../tables/p8.ts'
import { listDeletionLog, newRunId, writeLogEntry } from './log.ts'
import { planPersonDeletion, runPersonDeletion } from './person.ts'
import type { DeletionDeps, PersonDeletionPlan } from './person.ts'
import { deletionRules } from './rules.ts'
import { deleteKeys, listAll } from './r2.ts'
import { addGrant, addLine, addPerson, addPhoto, addSetting, readLines, recordingDb, snapshotAll, token, withoutLog, writesAudit } from './test-support.ts'
import type { Snapshot } from './test-support.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const BASE = 1_800_000_000_000
let clock = BASE
// The wall clock the log stamps entries with: later than any `at.nowMs` here, and moving on every read.
let wall = BASE + 1_000_000_000
// P2's and P8's stores: C1's (P3 and P4's) have their own rules and tests (ops/coverage), which need a BrandAgent double
// for personData, so these cases stay on P2's and P8's stores.
const p2AndP8 = [...coreTables, ...p8Tables]
const deps = (over: Partial<DeletionDeps> = {}): DeletionDeps => ({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: (clock += 1000) }, clock: () => ++wall, registry: p2AndP8, ...over })
let seeded: Seeded

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), BASE)
  // Something in the backup set and an earlier deletion-log entry, both of which must never change.
  await bucket.put('backups/d1/b1/manifest.json', '{"tables":[]}')
  await bucket.put('restore/r1/record.json', '{}')
  await writeLogEntry(bucket, { format: 1, runId: newRunId(), step: 0, phase: 'done', kind: 'retention', atMs: BASE - 1, actorId: SYSTEM_MEMBER_ID, cutoffs: [], removed: [] })
})

const planOk = async (d: DeletionDeps, memberId: string): Promise<PersonDeletionPlan> => {
  const r = await planPersonDeletion(d, { memberId })
  if (!('ok' in r)) throw new Error(`plan refused: ${r.refused}`)
  return r.ok
}

/** The independent count: a plain filter over the snapshot. */
const oracleCounts = (s: Snapshot, memberId: string) => ({
  members: (s.d1.members.find(r => r.id === memberId)?.pseudonymised_at_ms ?? null) === null ? 1 : 0,
  settings: s.d1.settings.filter(r => r.owner === memberId).length,
  'photos/': Object.keys(s.r2).filter(k => k.startsWith(`photos/${memberId}/`)).length,
})

describe('refusals (failure 6)', () => {
  it('refuses at plan, writing nothing: the last active Admin, Inhouse and service rows, unknown and malformed ids', async () => {
    const before = await snapshotAll(db, bucket)
    const cases: [string, string][] = [
      [seeded.members.admin, 'last_admin'],
      [seeded.members.inhouse, 'not_person'],
      [SYSTEM_MEMBER_ID, 'not_person'],
      ['m_smoke', 'not_person'],
      ['m_nobodyhasthisid', 'not_found'],
      ['x', 'bad_id'],
      ['m_../backups', 'bad_id'],
      ['m_a/b', 'bad_id'],
      ['', 'bad_id'],
    ]
    for (const [memberId, refused] of cases) expect(await planPersonDeletion(deps(), { memberId }), memberId).toEqual({ refused })
    expect(await snapshotAll(db, bucket)).toEqual(before)
  })

  it('refuses at run through P2\'s guard when the person became the last active Admin, with a refused entry only', async () => {
    const other = await addPerson(db, { role: 'admin', status: 'active' }, seeded.members.admin, BASE)
    const plan = await planOk(deps(), other.id)
    // Sam stops being an active Admin: `other` is now the last one.
    await db.prepare("UPDATE members SET status = 'removed' WHERE id = ?").bind(seeded.members.admin).run()
    try {
      const before = await snapshotAll(db, bucket)
      const d = deps()
      expect(await runPersonDeletion(d, plan)).toEqual({ refused: 'last_admin' })
      const after = await snapshotAll(db, bucket)
      expect(withoutLog(after)).toEqual(withoutLog(before))
      const mine = (await listDeletionLog(bucket)).filter(e => e.entry.memberId === other.id).map(e => [e.entry.step, e.entry.phase])
      expect(mine).toEqual([[0, 'start'], [1, 'refused']])
    } finally {
      await db.prepare("UPDATE members SET status = 'active' WHERE id = ?").bind(seeded.members.admin).run()
    }
  })

  it('runs only from a plan made by planPersonDeletion (failure 4)', async () => {
    const p = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
    const forged = { memberId: p.id, alreadyPseudonymised: false, counts: {}, atMs: 0, steps: [] }
    await expect(runPersonDeletion(deps(), forged)).rejects.toThrow(/only from a plan/)
  })
})

/** Generated people, with personal and brand settings, grants, audit lines and photos that reference them. */
const worldArb = fc.record({
  people: fc.array(fc.record({ role: fc.constantFrom('member' as const, 'admin' as const), status: fc.constantFrom('invited' as const, 'active' as const, 'removed' as const) }), { minLength: 1, maxLength: 4 }),
  personal: fc.array(fc.nat(), { maxLength: 6 }),
  brand: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean()), { maxLength: 4 }),
  grants: fc.array(fc.tuple(fc.nat(), fc.option(fc.nat(), { nil: null })), { maxLength: 3 }),
  lines: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat()), { maxLength: 4 }),
  photos: fc.array(fc.nat(), { maxLength: 4 }),
  pick: fc.nat(),
})

type World = { ids: string[]; people: Awaited<ReturnType<typeof addPerson>>[]; markers: Record<string, string[]> }

type WorldSpec = typeof worldArb extends fc.Arbitrary<infer T> ? T : never

async function build(w: WorldSpec): Promise<World> {
  const people = []
  for (const spec of w.people) people.push(await addPerson(db, spec, seeded.members.admin, clock))
  const ids = [...people.map(p => p.id), seeded.members.dana, seeded.members.leo, seeded.members.invite, seeded.members.admin, seeded.members.inhouse]
  const at = (n: number) => ids[n % ids.length]
  for (const n of w.personal) await addSetting(db, at(n), 'Dark', at(n), clock)
  for (const [a, b, approver] of w.brand) await addSetting(db, 'brand', approver ? at(a) : 'USD', at(b), clock)
  for (const [a, b] of w.grants) await addGrant(db, at(a), b === null ? null : at(b), clock)
  for (const [a, b, c] of w.lines) await addLine(db, at(a), at(b), { memberId: at(c), value: at(a) }, clock)
  const markers: Record<string, string[]> = {}
  for (const n of w.photos) (markers[at(n)] ??= []).push((await addPhoto(db, bucket, at(n))).marker)
  return { ids, people, markers }
}

describe('one person, nothing else (failures 1, 2, 3, 7, 8)', () => {
  test.prop([worldArb], { numRuns: 25 })('removes exactly the person\'s data and logs it', async w => {
    const world = await build(w)
    // Any person but the seeded Admin (the last active Admin: refused, tested above).
    const candidates = world.ids.filter(id => id !== seeded.members.admin && id !== seeded.members.inhouse)
    const P = candidates[w.pick % candidates.length]
    const before = await snapshotAll(db, bucket)
    const formerRow = before.d1.members.find(r => r.id === P)!

    const rec = recordingDb(db)
    const d = deps({ db: rec.db })
    const plan = await planOk(d, P)
    expect(await snapshotAll(db, bucket), 'the dry run writes nothing').toEqual(before)
    expect(plan.counts).toEqual(oracleCounts(before, P))
    const result = await runPersonDeletion(d, plan)
    if (!('ok' in result)) throw new Error(`run refused: ${JSON.stringify(result)}`)
    expect(result.ok.removed).toEqual(plan.counts)
    expect(rec.sql.filter(writesAudit)).toEqual([])

    const after = await snapshotAll(db, bucket)
    // Every table but members and settings is identical; the audit log above all.
    for (const t of Object.keys(before.d1)) if (t !== 'members' && t !== 'settings') expect(after.d1[t], t).toEqual(before.d1[t])
    expect(after.d1.settings).toEqual(before.d1.settings.filter(r => r.owner !== P))
    expect(after.d1.members.filter(r => r.id !== P)).toEqual(before.d1.members.filter(r => r.id !== P))
    const row = after.d1.members.find(r => r.id === P)!
    if (formerRow.pseudonymised_at_ms === null) {
      expect(row).toEqual({
        ...formerRow,
        name: FORMER_MEMBER, title: null, email_norm: null, photo_key: null, subject: null, status: 'removed',
        removed_at_ms: formerRow.removed_at_ms ?? d.at.nowMs, pseudonymised_at_ms: d.at.nowMs, rev: (formerRow.rev as number) + 1, req_id: row.req_id,
      })
    } else expect(row).toEqual(formerRow)
    // R2: only the person's photos went, and the log gained exactly this run's start and done.
    const expectR2 = Object.fromEntries(Object.entries(before.r2).filter(([k]) => !k.startsWith(`photos/${P}/`)))
    const added = Object.keys(after.r2).filter(k => !(k in before.r2))
    expect(Object.fromEntries(Object.entries(after.r2).filter(([k]) => !added.includes(k)))).toEqual(expectR2)
    expect(added.every(k => k.startsWith('deletion-log/'))).toBe(true)
    const log = (await listDeletionLog(bucket)).filter(e => e.entry.runId === result.ok.runId)
    expect(log.map(e => [e.entry.step, e.entry.phase])).toEqual([[0, 'start'], [1, 'done']])
    expect(added.sort()).toEqual(log.map(e => e.key).sort())
    const done = log.find(e => e.entry.phase === 'done')!.entry
    expect(done).toMatchObject({ kind: 'person', memberId: P, actorId: SYSTEM_MEMBER_ID })
    // Each entry carries the clock at its write, never the job's pinned time.
    expect(log[0].entry.atMs).toBeGreaterThan(d.at.nowMs)
    expect(done.atMs).toBeGreaterThan(log[0].entry.atMs)
    expect(Object.fromEntries(done.removed!.map(r => [r.store, r.count]))).toEqual(plan.counts)
    expect(done.removed!.find(r => r.store === 'photos/')!.keys!.sort()).toEqual(Object.keys(before.r2).filter(k => k.startsWith(`photos/${P}/`)).sort())

    // Their export afterwards holds none of what they were.
    const exp = await planExport(d, { kind: 'person', memberId: P })
    if (!('ok' in exp)) throw new Error('export refused')
    const { text } = await readLines(runExport(d, exp.ok))
    const former = [formerRow.name, formerRow.email_norm, formerRow.title, formerRow.subject].filter((v): v is string => typeof v === 'string' && v !== FORMER_MEMBER)
    for (const v of former) expect(text.includes(v), v).toBe(false)
    for (const m of world.markers[P] ?? []) expect(text.includes(btoa(m))).toBe(false)
    // And the log holds none of it either.
    const logText = JSON.stringify(log)
    for (const v of former) expect(logText.includes(v), v).toBe(false)
  })
})

describe('stale plans (failure 4)', () => {
  for (const change of ['setting', 'photo'] as const) {
    it(`refuses plan_stale and changes nothing when a ${change} lands between plan and run`, async () => {
      const p = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
      await addSetting(db, p.id, 'Dark', p.id, BASE)
      const plan = await planOk(deps(), p.id)
      if (change === 'setting') await addSetting(db, p.id, 'Light', p.id, BASE)
      else await addPhoto(db, bucket, p.id)
      const before = await snapshotAll(db, bucket)
      const r = await runPersonDeletion(deps(), plan)
      expect(r).toMatchObject({ refused: 'plan_stale', planned: plan.counts })
      expect(await snapshotAll(db, bucket)).toEqual(before)
    })
  }
})

describe('idempotent (failure 5)', () => {
  const failures = ['start', 'pseudonymise', 'rows', 'objects', 'r2-delete'] as const
  for (const where of failures) {
    it(`a run that fails after ${where} is finished by a re-run, and a third run changes nothing more`, async () => {
      const p = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
      await addSetting(db, p.id, 'Dark', p.id, BASE)
      await addPhoto(db, bucket, p.id)
      await addPhoto(db, bucket, p.id)
      const boom = new Error(`injected after ${where}`)
      const failing = where === 'r2-delete'
        ? deps({ bucket: Object.assign(Object.create(bucket) as R2Bucket, { delete: () => Promise.reject(boom), list: bucket.list.bind(bucket), get: bucket.get.bind(bucket), put: bucket.put.bind(bucket) }) })
        : deps()
      const plan = await planOk(failing, p.id)
      await expect(runPersonDeletion(failing, plan, { afterStep: async s => { if (s === where) throw boom } })).rejects.toThrow(boom.message)

      const again = await planOk(deps(), p.id)
      expect(again.alreadyPseudonymised).toBe(where !== 'start')
      const second = await runPersonDeletion(deps(), again)
      if (!('ok' in second)) throw new Error('second run refused')
      const settled = await snapshotAll(db, bucket)
      expect(settled.d1.settings.filter(r => r.owner === p.id)).toEqual([])
      expect(Object.keys(settled.r2).filter(k => k.startsWith(`photos/${p.id}/`))).toEqual([])
      expect(settled.d1.members.find(r => r.id === p.id)).toMatchObject({ name: FORMER_MEMBER, email_norm: null, subject: null })

      const third = await planOk(deps(), p.id)
      expect(third).toMatchObject({ alreadyPseudonymised: true, counts: { members: 0, settings: 0, 'photos/': 0 } })
      expect(await runPersonDeletion(deps(), third)).toMatchObject({ ok: { removed: { members: 0, settings: 0, 'photos/': 0 } } })
      expect(withoutLog(await snapshotAll(db, bucket))).toEqual(withoutLog(settled))
    })
  }
})

describe('the registry guard (failure 9)', () => {
  it('throws by name on a store with no rule, or a rule its class forbids', async () => {
    const p = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
    const extra = { kind: 'd1' as const, name: 'later_store', retention: 'retention_period' as const, personKeys: ['member_id'], export: true }
    await expect(planPersonDeletion(deps({ registry: [...p2AndP8, extra] }), { memberId: p.id })).rejects.toThrow(/later_store/)
    await expect(planPersonDeletion(deps({ rules: { ...deletionRules, audit_log: { action: 'delete_rows', column: 'actor_id' } } }), { memberId: p.id })).rejects.toThrow(/audit_log/)
    const { members: _m, ...noMembers } = deletionRules
    await expect(planPersonDeletion(deps({ rules: noMembers }), { memberId: p.id })).rejects.toThrow(/members/)
  })

  it('has a rule for every store in the real registry', () => {
    expect(tables.filter(e => deletionRules[e.name] === undefined).map(e => e.name)).toEqual([])
  })
})

describe('the deletion log (failure 8)', () => {
  it('lists by time across runs and by write order within a run, after a watermark, and refuses an object that is not an entry', async () => {
    // A run whose phases sort the other way round by name: start, refused, done at steps 0, 1, 2, all at one atMs.
    const runId = newRunId()
    for (const [step, phase] of (['start', 'refused', 'done'] as const).entries()) await writeLogEntry(bucket, { format: 1, runId, step, phase, kind: 'person', atMs: BASE + 5, actorId: SYSTEM_MEMBER_ID, memberId: 'm_x' })
    const all = await listDeletionLog(bucket)
    expect(all.length).toBeGreaterThan(5)
    // The independent oracle: the entries' own fields, never the key text.
    const byFields = [...all].sort((a, b) => a.entry.atMs - b.entry.atMs || (a.entry.runId < b.entry.runId ? -1 : a.entry.runId > b.entry.runId ? 1 : 0) || a.entry.step - b.entry.step)
    expect(all.map(e => e.key)).toEqual(byFields.map(e => e.key))
    expect(all.filter(e => e.entry.runId === runId).map(e => e.entry.phase)).toEqual(['start', 'refused', 'done'])
    // Every run the jobs wrote numbers its entries 0, 1, 2... with start first.
    const runs = new Map<string, typeof all>()
    for (const e of all) runs.set(e.entry.runId, [...(runs.get(e.entry.runId) ?? []), e])
    for (const [, es] of runs) {
      expect(es.map(e => e.entry.step)).toEqual(es.map((_, i) => i))
      if (es.length > 1) expect(es[0].entry.phase).toBe('start')
    }
    const mark = all[1].key
    expect((await listDeletionLog(bucket, { after: mark })).map(e => e.key)).toEqual(all.slice(2).map(e => e.key))
    // A malformed entry is refused by the schema, never written.
    await expect(writeLogEntry(bucket, { format: 1, runId: 'nothex', step: 0, phase: 'done', kind: 'person', atMs: 1, actorId: SYSTEM_MEMBER_ID })).rejects.toThrow()
    const key = `deletion-log/9999999999999-${'f'.repeat(16)}-0000-done.json`
    await bucket.put(key, JSON.stringify({ format: 1, runId: 'f'.repeat(16), step: 0, phase: 'done', kind: 'person', atMs: 9_999_999_999_999, actorId: 'm_x', name: 'Someone' }))
    try {
      await expect(listDeletionLog(bucket)).rejects.toThrow(key)
    } finally {
      await bucket.delete(key)
    }
  })
})

describe('the log\'s time is when an entry is written (failure 8)', () => {
  it('a run planned at T0 and run at T2 sorts after a backup watermark taken at T1', async () => {
    const T0 = BASE + 2_000_000_000
    const p = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
    await addSetting(db, p.id, 'Dark', p.id, BASE)
    // The plan and the run share one pinned `at` at T0, as a confirm flow that keeps the request's time would.
    const at = { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: T0 }
    let now = T0
    const d = deps({ at, clock: () => now })
    const plan = await planOk(d, p.id)
    // A backup at T1 takes the log's last key as its watermark.
    now = T0 + 1000
    const watermark = await writeLogEntry(bucket, { format: 1, runId: newRunId(), step: 0, phase: 'done', kind: 'retention', atMs: now, actorId: SYSTEM_MEMBER_ID, cutoffs: [], removed: [] })
    now = T0 + 2000
    const r = await runPersonDeletion(d, plan)
    if (!('ok' in r)) throw new Error('run refused')
    const after = (await listDeletionLog(bucket, { after: watermark })).filter(e => e.entry.runId === r.ok.runId)
    expect(after.map(e => [e.entry.phase, e.entry.atMs])).toEqual([['start', T0 + 2000], ['done', T0 + 2000]])
  })

  it('never stamps an entry earlier than the run\'s previous one, even if the clock steps back', async () => {
    const p = await addPerson(db, { role: 'member', status: 'active' }, seeded.members.admin, BASE)
    const times = [BASE + 3_000_000_000, BASE + 2_900_000_000]
    const d = deps({ clock: () => times.shift() ?? 0 })
    const r = await runPersonDeletion(d, await planOk(d, p.id))
    if (!('ok' in r)) throw new Error('run refused')
    const log = (await listDeletionLog(bucket)).filter(e => e.entry.runId === r.ok.runId)
    expect(log.map(e => [e.entry.phase, e.entry.atMs])).toEqual([['start', BASE + 3_000_000_000], ['done', BASE + 3_000_000_000]])
  })
})

describe('writing and reading the log (failure 8)', () => {
  it('writes an entry once: a second put onto its key throws and leaves the first', async () => {
    const e = { format: 1 as const, runId: newRunId(), step: 0, phase: 'done' as const, kind: 'person' as const, atMs: BASE + 7, actorId: SYSTEM_MEMBER_ID, memberId: 'm_once' }
    const key = await writeLogEntry(bucket, e)
    await expect(writeLogEntry(bucket, { ...e, memberId: 'm_twice' })).rejects.toThrow(/exists already/)
    expect(JSON.parse(await (await bucket.get(key))!.text())).toMatchObject({ memberId: 'm_once' })
  })

  it('lists at most `limit` entries, from a watermark, and refuses a bad limit', async () => {
    const all = await listDeletionLog(bucket)
    expect(all.length).toBeGreaterThan(3)
    expect((await listDeletionLog(bucket, { limit: 2 })).map(e => e.key)).toEqual(all.slice(0, 2).map(e => e.key))
    expect((await listDeletionLog(bucket, { after: all[0].key, limit: 2 })).map(e => e.key)).toEqual(all.slice(1, 3).map(e => e.key))
    expect((await listDeletionLog(bucket, { limit: all.length + 50 })).length).toBe(all.length)
    for (const bad of [0, -1, 1.5]) await expect(listDeletionLog(bucket, { limit: bad })).rejects.toThrow(/limit/)
  })
})

/** The real bucket, but every list returns at most 2 objects a page (`truncated` and a cursor for the rest). */
const twoKeyPages = (): R2Bucket => Object.assign(Object.create(bucket) as R2Bucket, {
  list: (o?: R2ListOptions) => bucket.list({ ...o, limit: 2 }),
  get: bucket.get.bind(bucket),
  put: bucket.put.bind(bucket),
  delete: bucket.delete.bind(bucket),
  head: bucket.head.bind(bucket),
})

describe('paging (failure 2)', () => {
  it('listAll follows every 2-key page, from startAfter, up to max', async () => {
    const prefix = `photos/m_page${token()}/`
    const keys = Array.from({ length: 7 }, (_, i) => `${prefix}${i}`)
    for (const k of keys) await bucket.put(k, 'x')
    const paged = twoKeyPages()
    expect((await listAll(paged, prefix)).map(o => o.key)).toEqual(keys)
    expect((await listAll(paged, prefix, keys[2])).map(o => o.key)).toEqual(keys.slice(3))
    expect((await listAll(paged, prefix, undefined, 3)).map(o => o.key)).toEqual(keys.slice(0, 3))
    await bucket.delete(keys)
  })

  it('deleteKeys sends at most 1,000 keys a call, every key once', async () => {
    const calls: string[][] = []
    const recording = { delete: async (k: string | string[]) => { calls.push(Array.isArray(k) ? k : [k]) } } as unknown as R2Bucket
    const keys = Array.from({ length: 2001 }, (_, i) => `photos/m_x/${i}`)
    await deleteKeys(recording, keys)
    expect(calls.map(c => c.length)).toEqual([1000, 1000, 1])
    expect(calls.flat()).toEqual(keys)
  })

  it('deletes m_1\'s photos across pages and leaves m_10\'s, whose prefix starts the same', async () => {
    const ids = ['m_1', 'm_10']
    for (const id of ids) {
      await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'person', 'member', 'active', 'Paged', ?)").bind(id, BASE).run()
      for (let i = 0; i < 5; i++) await addPhoto(db, bucket, id)
    }
    const [m1, m10] = ids
    const d = deps({ bucket: twoKeyPages() })
    const plan = await planOk(d, m1)
    expect(plan.counts['photos/']).toBe(5)
    const r = await runPersonDeletion(d, plan)
    expect(r).toMatchObject({ ok: { removed: { 'photos/': 5 } } })
    expect(await listAll(bucket, `photos/${m1}/`)).toEqual([])
    expect((await listAll(bucket, `photos/${m10}/`)).length).toBe(5)
  })
})
