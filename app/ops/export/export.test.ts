// Export (P8 acceptance 3). Ways it can fail, written down first:
//  1. the brand export misses a row or an object of an exported store, or alters one (a value, a type, a byte);
//  2. a person's export misses a row a person key names (a column, a JSON path, a bare JSON value), or holds a row
//     that doesn't name them, or another person's name or email;
//  3. the header doesn't list every registry entry, so what isn't exported is invisible;
//  4. the dry run writes something, or counts other than the stream holds;
//  5. it runs without a plan, exports a malformed or non-person id, or skips a store it can't read without saying.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../server/db/ids.ts'
import { openStores } from '../../server/db/stores.ts'
import { seedBrand } from '../../server/seed/seed.ts'
import type { Seeded } from '../../server/seed/seed.ts'
import { newRunId, writeLogEntry } from '../delete/log.ts'
import { addGrant, addLine, addPerson, addPhoto, addSetting, readLines, recordingDb, snapshotAll, token, writesAudit } from '../delete/test-support.ts'
import type { Snapshot } from '../delete/test-support.ts'
import { tables } from '../tables/index.ts'
import type { TableEntry } from '../tables/types.ts'
import { planExport, runExport } from './export.ts'
import type { ExportPlan, ExportScope } from './export.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const BASE = 1_800_000_000_000
const d = () => ({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: BASE } })
let seeded: Seeded

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), BASE)
  await bucket.put('backups/d1/b1/manifest.json', '{"tables":[]}')
  await writeLogEntry(bucket, { format: 1, runId: newRunId(), phase: 'done', kind: 'person', atMs: BASE, actorId: SYSTEM_MEMBER_ID, memberId: seeded.members.leo, removed: [] })
})

const planOk = async (scope: ExportScope, deps = d()): Promise<ExportPlan> => {
  const r = await planExport(deps, scope)
  if (!('ok' in r)) throw new Error(`export refused: ${r.refused}`)
  return r.ok
}

const sortJson = (xs: unknown[]) => xs.map(x => JSON.stringify(x)).sort()

/** The JS oracle: does this row name the member through one of the entry's person keys? */
function names(entry: TableEntry, row: Record<string, unknown>, id: string): boolean {
  return entry.personKeys.some(key => {
    const [col, path] = key.split(':', 2)
    if (path !== undefined) {
      let v: unknown = JSON.parse(row[col] as string)
      for (const p of path.slice(2).split('.')) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined
      return v === id
    }
    return col.endsWith('_json') ? row[col] === JSON.stringify(id) : row[col] === id
  })
}

/** What a scope's export must hold, per store, from the snapshot alone. */
function expected(s: Snapshot, scope: ExportScope): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const e of tables.filter(t => t.export)) {
    if (e.kind === 'd1') {
      let rows = s.d1[e.name]
      if (scope.kind === 'person') {
        rows = rows.filter(r => names(e, r, scope.memberId))
        if (e.retention === 'account') rows = rows.map(r => (r.id === scope.memberId ? r : { id: r.id, invited_by: r.invited_by }))
      }
      out[e.name] = rows
    } else {
      const prefix = scope.kind === 'brand' ? e.name : e.personKeys.find(k => k.includes('<memberId>'))?.replace('<memberId>', scope.memberId)
      out[e.name] = prefix === undefined ? [] : Object.entries(s.r2).filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, contentType: o.contentType, base64: o.base64 }))
    }
  }
  return out
}

/** The stream's body lines, per store, in the oracle's shape. */
function got(lines: Record<string, unknown>[]): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const e of tables.filter(t => t.export)) out[e.name] = []
  for (const l of lines.slice(1, -1)) {
    const store = l.store as string
    out[store].push('row' in l ? l.row : { key: l.key, contentType: l.contentType, base64: l.base64 })
    if (!('row' in l)) expect(l.size).toBe(atob(l.base64 as string).length)
  }
  return out
}

const worldArb = fc.record({
  people: fc.array(fc.constantFrom('invited' as const, 'active' as const, 'removed' as const), { minLength: 1, maxLength: 3 }),
  personal: fc.array(fc.nat(), { maxLength: 4 }),
  brand: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean()), { maxLength: 3 }),
  grants: fc.array(fc.tuple(fc.nat(), fc.option(fc.nat(), { nil: null })), { maxLength: 2 }),
  lines: fc.array(fc.tuple(fc.nat(), fc.nat(), fc.nat(), fc.nat()), { maxLength: 4 }),
  photos: fc.array(fc.nat(), { maxLength: 3 }),
  pick: fc.nat(),
})

describe('export completeness (failures 1 to 4, property)', () => {
  test.prop([worldArb], { numRuns: 20 })('the brand export is every exported store whole; a person export is exactly what names them', async w => {
    const ids: string[] = [seeded.members.dana, seeded.members.leo, seeded.members.admin, seeded.members.invite]
    for (const status of w.people) {
      const inviter = ids[ids.length - 1]
      ids.push((await addPerson(db, { role: 'member', status }, inviter, BASE)).id)
    }
    const at = (n: number) => ids[n % ids.length]
    for (const n of w.personal) await addSetting(db, at(n), 'Dark', at(n), BASE)
    for (const [a, b, approver] of w.brand) await addSetting(db, 'brand', approver ? at(a) : 'USD', at(b), BASE)
    for (const [a, b] of w.grants) await addGrant(db, at(a), b === null ? null : at(b), BASE)
    for (const [a, b, c, e] of w.lines) await addLine(db, at(a), at(b), { memberId: at(c), replaces: at(e), value: at(a) }, BASE)
    for (const n of w.photos) await addPhoto(db, bucket, at(n))
    const before = await snapshotAll(db, bucket)

    for (const scope of [{ kind: 'brand' } as const, { kind: 'person', memberId: at(w.pick) } as const]) {
      const rec = recordingDb(db)
      const deps = { ...d(), db: rec.db }
      const plan = await planOk(scope, deps)
      expect(await snapshotAll(db, bucket), 'the dry run writes nothing').toEqual(before)
      const want = expected(before, scope)
      expect(plan.counts).toEqual(Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v.length])))
      const { lines } = await readLines(runExport(deps, plan))
      expect(rec.sql.filter(writesAudit)).toEqual([])
      expect(lines[0]).toEqual({ format: 1, kind: scope.kind, ...(scope.kind === 'person' ? { memberId: scope.memberId } : {}), atMs: BASE, stores: tables.map(e => ({ kind: e.kind, name: e.name, retention: e.retention, export: e.export })) })
      expect(lines.at(-1)).toEqual({ end: true, counts: plan.counts })
      const have = got(lines)
      for (const store of Object.keys(want)) expect(sortJson(have[store]), store).toEqual(sortJson(want[store]))
      // D1 rows come by primary key.
      const memberIds = have.members.map(r => (r as { id: string }).id)
      expect(memberIds).toEqual([...memberIds].sort())
      if (scope.kind === 'person') {
        // Another person's name or email never appears in a person's export.
        const others = before.d1.members.filter(r => r.id !== scope.memberId && r.kind === 'person')
        const text = JSON.stringify(lines)
        for (const o of others) for (const v of [o.name, o.email_norm]) if (typeof v === 'string' && v !== 'Former member') expect(text.includes(v), v).toBe(false)
      }
      expect(await snapshotAll(db, bucket), 'the export writes nothing').toEqual(before)
    }
  })
})

describe('what export refuses (failure 5)', () => {
  it('refuses a malformed, unknown or non-person id', async () => {
    expect(await planExport(d(), { kind: 'person', memberId: 'photos/' })).toEqual({ refused: 'bad_id' })
    expect(await planExport(d(), { kind: 'person', memberId: 'm_nobody' })).toEqual({ refused: 'not_found' })
    expect(await planExport(d(), { kind: 'person', memberId: SYSTEM_MEMBER_ID })).toEqual({ refused: 'not_person' })
    expect(await planExport(d(), { kind: 'person', memberId: seeded.members.inhouse })).toEqual({ refused: 'not_person' })
  })

  it('throws by name on a store it has no reader for, and runs only from its own plan', async () => {
    const extra: TableEntry = { kind: 'do', name: 'LaterObject', retention: 'retention_period', personKeys: ['memberId'], export: true }
    await expect(planExport({ ...d(), registry: [...tables, extra] }, { kind: 'brand' })).rejects.toThrow(/LaterObject/)
    const forged: ExportPlan = { scope: { kind: 'brand' }, atMs: BASE, registry: tables, counts: {} }
    expect(() => runExport(d(), forged)).toThrow(/only from a plan/)
  })
})
