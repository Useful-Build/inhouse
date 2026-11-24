// Export (P8 acceptance 3). Ways it can fail, written down first:
//  1. the brand export misses a row or an object of an exported store, or alters one (a value, a type, a byte);
//  2. a person's export misses a row a person key names (a column, a JSON path, a bare JSON value), or holds a row
//     that doesn't name them, or another person's name or email;
//  3. the header doesn't list every registry entry, so what isn't exported is invisible;
//  4. the dry run writes something, or counts other than the stream holds;
//  5. it runs without a plan, exports a malformed or non-person id, or skips a store it can't read without saying;
//  6. an object is held whole (or read ahead of the download) on its way out, or its base64 pieces don't join back into
//     its bytes, or a short read passes as the whole object;
//  7. the plan's cost isn't the calls the plan and the run make, or a plan past its budget isn't refused.
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
import { B64_PIECE, PAGE, planExport, runExport } from './export.ts'
import type { ExportPlan, ExportScope } from './export.ts'

const db = env.DB
const bucket = env.FILES as R2Bucket
const BASE = 1_800_000_000_000
const d = () => ({ db, bucket, at: { actorId: SYSTEM_MEMBER_ID, requestId: `req-${token()}`, nowMs: BASE } })
let seeded: Seeded

beforeAll(async () => {
  seeded = await seedBrand(db, openStores(env), BASE)
  await bucket.put('backups/d1/b1/manifest.json', '{"tables":[]}')
  await writeLogEntry(bucket, { format: 1, runId: newRunId(), step: 0, phase: 'done', kind: 'person', atMs: BASE, actorId: SYSTEM_MEMBER_ID, memberId: seeded.members.leo, removed: [] })
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
function expected(s: Snapshot, scope: Exclude<ExportScope, { kind: 'brandForCaller' }>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {}
  for (const e of tables.filter(t => t.export)) {
    if (e.kind === 'd1') {
      let rows = s.d1[e.name]
      if (scope.kind === 'person') {
        rows = rows.filter(r => names(e, r, scope.memberId))
        if (e.name === 'members') rows = rows.map(r => (r.id === scope.memberId ? r : { id: r.id, invited_by: r.invited_by }))
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
  pageSize: fc.integer({ min: 1, max: 4 }),
})

describe('export completeness (failures 1 to 4, property)', () => {
  it('exports every column of the person’s usage turns and excludes other people’s turns', async () => {
    const insert = db.prepare(`INSERT INTO usage_turns
      (turn_id, run_id, chat_id, member_id, model, month, reserved_micro, created_at_ms, source)
      VALUES (?, 'r_usage', 'c_usage', ?, 'test-model', '2099-01', 250000, ?, 'tally')`)
    await db.batch([
      db.prepare("INSERT INTO usage_months (month, cap_micro) VALUES ('2099-01', 1000000)"),
      insert.bind('t_own_usage', seeded.members.dana, BASE),
      insert.bind('t_other_usage', seeded.members.leo, BASE),
    ])
    const plan = await planOk({ kind: 'person', memberId: seeded.members.dana })
    const { lines } = await readLines(runExport(d(), plan))
    expect(plan.counts.usage_turns).toBe(1)
    const row = await db.prepare("SELECT * FROM usage_turns WHERE turn_id = 't_own_usage'").first()
    expect(row).toMatchObject({ model: 'test-model', reserved_micro: 250000 })
    expect(lines.filter(l => l.store === 'usage_turns')).toEqual([{ store: 'usage_turns', row }])
  })

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
      // Small pages, so every store is read across several keyset pages.
      const { lines } = await readLines(runExport(deps, plan, { pageSize: w.pageSize }))
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

describe('keyset paging (failure 1)', () => {
  // A composite primary key (with ties on its first column) and a table with none (paged by rowid), with fixture
  // entries passed in as the registry.
  const fixtures: TableEntry[] = [
    { kind: 'd1', name: 'export_composite', retention: 'config', personKeys: [], export: true },
    { kind: 'd1', name: 'export_nopk', retention: 'config', personKeys: [], export: true },
  ]
  test.prop([fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.integer({ min: -5, max: 5 })), { maxLength: 15 }), fc.array(fc.constantFrom('x', 'y'), { maxLength: 9 }), fc.integer({ min: 1, max: 4 })], { numRuns: 25 })(
    'reads every row once, by primary key, whatever the page size', async (pairs, values, pageSize) => {
      await db.prepare('CREATE TABLE IF NOT EXISTS export_composite (a TEXT NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b))').run()
      await db.prepare('CREATE TABLE IF NOT EXISTS export_nopk (v TEXT)').run()
      for (const [a, b] of pairs) await db.prepare('INSERT OR IGNORE INTO export_composite (a, b, v) VALUES (?, ?, ?)').bind(a, b, token()).run()
      // Duplicate values: only the rowid tells these rows apart.
      for (const v of values) await db.prepare('INSERT INTO export_nopk (v) VALUES (?)').bind(v).run()
      const deps = { ...d(), registry: fixtures }
      const plan = await planOk({ kind: 'brand' }, deps)
      const { lines } = await readLines(runExport(deps, plan, { pageSize }))
      const rows = (store: string) => lines.filter(l => l.store === store).map(l => l.row)
      const composite = (await db.prepare('SELECT * FROM export_composite ORDER BY a, b').all()).results
      const nopk = (await db.prepare('SELECT * FROM export_nopk ORDER BY rowid').all()).results
      expect(rows('export_composite')).toEqual(composite)
      expect(rows('export_nopk')).toEqual(nopk)
      expect(lines.at(-1)).toEqual({ end: true, counts: { export_composite: composite.length, export_nopk: nopk.length } })
    },
  )

  it('refuses a page size outside 1 to 1,000', async () => {
    const plan = await planOk({ kind: 'brand' })
    for (const bad of [0, 1001, 1.5]) expect(() => runExport(d(), plan, { pageSize: bad })).toThrow(/pageSize/)
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
    const forged: ExportPlan = { scope: { kind: 'brand' }, atMs: BASE, registry: tables, counts: {}, cost: { d1: 0, r2: 0 } }
    expect(() => runExport(d(), forged)).toThrow(/only from a plan/)
  })
})

/** A fake bucket holding one object whose body is made a chunk at a time as it's pulled, counting what it made. */
function lazyBucket(key: string, size: number, chunk: number, byteAt: (i: number) => number, opts: { short?: number } = {}) {
  const made = { bytes: 0 }
  const body = () => {
    let at = 0
    const end = size - (opts.short ?? 0)
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= end) return c.close()
        const n = Math.min(chunk, end - at)
        const b = new Uint8Array(n)
        for (let j = 0; j < n; j++) b[j] = byteAt(at + j)
        at += n
        made.bytes += n
        c.enqueue(b)
      },
    }, { highWaterMark: 0 })
  }
  const bucket = {
    list: async () => ({ objects: [{ key, size }], truncated: false, delimitedPrefixes: [] }),
    get: async (k: string) => (k === key ? { key, size, httpMetadata: { contentType: 'application/octet-stream' }, body: body() } : null),
  } as unknown as R2Bucket
  return { bucket, made }
}
const bigRegistry: TableEntry[] = [{ kind: 'r2', name: 'big/', retention: 'config', personKeys: [], export: true }]
const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0))

describe('bounded memory (failure 6)', () => {
  it('streams a 20 MiB object in pieces as the download pulls it, never holding it whole', async () => {
    const MiB = 1 << 20
    const SIZE = 20 * MiB
    // Not a multiple of 3, so pieces straddle the source's chunks.
    const CHUNK = MiB + 1
    const byteAt = (i: number) => (i * 7 + 3) % 251
    const { bucket: big, made } = lazyBucket('big/one.bin', SIZE, CHUNK, byteAt)
    const deps = { ...d(), bucket: big, registry: bigRegistry }
    const plan = await planOk({ kind: 'brand' }, deps)
    const reader = runExport(deps, plan).getReader()
    const text = new TextDecoder()
    const header = await reader.read()
    expect(text.decode(header.value)).toMatch(/^\{"format":1,/)
    expect(made.bytes, 'nothing is read before the download asks').toBe(0)
    const prefix = text.decode((await reader.read()).value)
    expect(prefix).toBe('{"store":"big/","key":"big/one.bin","contentType":"application/octet-stream","size":20971520,"base64":"')
    let decoded = 0
    let pieces = 0
    let largest = 0
    for (;;) {
      const { value, done } = await reader.read()
      expect(done).toBe(false)
      const piece = text.decode(value)
      if (piece === '"}\n') break
      largest = Math.max(largest, value!.byteLength)
      const bytes = fromBase64(piece)
      for (let j = 0; j < bytes.length; j++) if (bytes[j] !== byteAt(decoded + j)) throw new Error(`byte ${decoded + j} differs`)
      decoded += bytes.length
      pieces++
      // The body is pulled one source chunk at a time, only as the pieces go out: never more than a chunk ahead.
      expect(made.bytes - decoded).toBeLessThanOrEqual(CHUNK + 2)
    }
    expect(decoded).toBe(SIZE)
    expect(largest).toBeLessThanOrEqual((B64_PIECE / 3) * 4)
    expect(pieces).toBeGreaterThan(SIZE / B64_PIECE)
    const end = JSON.parse(text.decode((await reader.read()).value)) as Record<string, unknown>
    expect(end).toEqual({ end: true, counts: { 'big/': 1 } })
    expect((await reader.read()).done).toBe(true)
  })

  test.prop([fc.uint8Array({ maxLength: 200 }), fc.integer({ min: 1, max: 7 })], { numRuns: 60 })(
    'the pieces join into the object\'s base64 whatever its length and the body\'s chunk size', async (bytes, chunk) => {
      const { bucket: small } = lazyBucket('big/x', bytes.length, chunk, i => bytes[i])
      const deps = { ...d(), bucket: small, registry: bigRegistry }
      const { lines } = await readLines(runExport(deps, await planOk({ kind: 'brand' }, deps)))
      expect(lines[1]).toEqual({ store: 'big/', key: 'big/x', contentType: 'application/octet-stream', size: bytes.length, base64: btoa(String.fromCharCode(...bytes)) })
    },
  )

  it('fails the stream (no end line) when the body is shorter than the object', async () => {
    const { bucket: short } = lazyBucket('big/short', 10, 4, i => i, { short: 2 })
    const deps = { ...d(), bucket: short, registry: bigRegistry }
    await expect(readLines(runExport(deps, await planOk({ kind: 'brand' }, deps)))).rejects.toThrow(/read 8 bytes of 10/)
  })
})

describe('the plan\'s cost and budget (failure 7)', () => {
  const costRegistry: TableEntry[] = [
    { kind: 'd1', name: 'export_cost', retention: 'config', personKeys: [], export: true },
    { kind: 'r2', name: 'costtest/', retention: 'config', personKeys: [], export: true },
  ]
  it('is exactly the D1 queries and R2 calls the plan and the run make', async () => {
    await db.prepare('CREATE TABLE IF NOT EXISTS export_cost (id INTEGER PRIMARY KEY, v TEXT)').run()
    await db.prepare('DELETE FROM export_cost').run()
    // Two full pages and one row more: three page reads.
    const rows = 2 * PAGE + 1
    for (let i = 0; i < rows; i += 100) await db.batch(Array.from({ length: Math.min(100, rows - i) }, (_, j) => db.prepare('INSERT INTO export_cost (id, v) VALUES (?, ?)').bind(i + j, 'x')))
    for (const k of ['a', 'b', 'c']) await bucket.put(`costtest/${k}`, k)
    const rec = recordingDb(db)
    let r2 = 0
    const counting = { list: (o?: R2ListOptions) => { r2++; return bucket.list(o) }, get: (k: string) => { r2++; return bucket.get(k) } } as unknown as R2Bucket
    const deps = { ...d(), db: rec.db, bucket: counting, registry: costRegistry }
    const plan = await planOk({ kind: 'brand' }, deps)
    // Count and PRAGMA, then three pages; two lists (plan and run) and three gets.
    expect(plan.cost).toEqual({ d1: 1 + 1 + 3, r2: 2 + 3 })
    await readLines(runExport(deps, plan))
    expect({ d1: rec.sql.length, r2 }).toEqual(plan.cost)
  })

  it('refuses too_large once past either budget, and plans when it fits exactly', async () => {
    const deps = { ...d(), registry: costRegistry }
    const cost = (await planOk({ kind: 'brand' }, deps)).cost
    expect(await planExport(deps, { kind: 'brand' }, { budget: { d1: cost.d1 - 1, r2: cost.r2 } })).toEqual({ refused: 'too_large' })
    expect(await planExport(deps, { kind: 'brand' }, { budget: { d1: cost.d1, r2: cost.r2 - 1 } })).toEqual({ refused: 'too_large' })
    expect(await planExport(deps, { kind: 'brand' }, { budget: cost })).toMatchObject({ ok: { cost } })
  })
})
