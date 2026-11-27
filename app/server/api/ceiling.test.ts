// Routes 150 and 151 (Stage 1 M3-C, N26) on real D1 in the Workers runtime. Ways they can fail, written down first:
//  1. someone other than the Inhouse team changes the ceiling (an admin or a member past the matrix, or a member reading it);
//  2. a change goes through while editing is off in a product-shaped build (the constant false, the test build's switch
//     not compiled in, or compiled in but not switched on);
//  3. a change made against a stale `rev` (or a "create" for a row that exists) changes anything or writes a line;
//  4. lowering a value doesn't raise `lowered_rev`, or raising one does (an old grant would come back to life);
//  5. a change and its `ceiling.changed` line don't land together (one without the other), or the line's old and new
//     values aren't the row's;
//  6. the list leaves out an operation, shows a row it doesn't have as on, or tells someone they may edit who can't.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { CeilingListSchema, CeilingRowSchema } from '../../shared/contract/ceiling.ts'
import type { CeilingRow, CeilingValues } from '../../shared/contract/ceiling.ts'
import { accessMatrix } from '../access-matrix.ts'
import { checkAccess } from '../auth/matrix.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import { brokenAudit, ctx, lastLineId, linesSince, personPrincipal } from '../db/test-support.ts'
import { OPERATION_KEYS } from '../outbox/operations/index.ts'
import { resetPermissions } from '../permissions/test-support.ts'
import type { HandlerContext } from '../routes.ts'
import { CEILING_EDIT_ON, ceilingHandlers } from './ceiling.ts'

const db = env.DB
const stores = openStores(env)
const NOW = 1_800_000_000_000
const IH = 'm_ceiling_ih'
const inhouse: Principal = { kind: 'inhouse', memberId: IH, subject: 's_ih', grant: null, requestId: 'r', expMs: 4_102_444_800_000 }
const admin = personPrincipal('m_ceiling_admin', 'admin')
const member = personPrincipal('m_ceiling_member', 'member')

/** The test build compiled in and switched on: the one build where a change goes through before M3-J. */
type Build = { build: boolean; flag: string | undefined }
const ON: Build = { build: true, flag: '1' }

function call(p: Principal, init: { method?: 'GET' | 'PUT'; operation?: string; body?: unknown }, build: Build = ON, s = stores) {
  const path = init.operation === undefined ? '/api/ceiling' : `/api/ceiling/${init.operation}`
  const { c } = ctx(s, p, { method: init.method ?? 'GET', path, body: init.body, params: init.operation === undefined ? {} : { operation: init.operation }, nowMs: NOW })
  const h = ceilingHandlers(build.build)
  const hc = { ...c, env: build.flag === undefined ? {} : { INHOUSE_TEST_BUILD: build.flag } } as unknown as HandlerContext
  return (init.method === 'PUT' ? h.put : h.get)(hc)
}
const json = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> })

const TAG = 'shopify.order.tag_add'
const values = (o: Partial<CeilingValues> = {}): CeilingValues => ({ enabled: true, perDayMax: 200, unitsMax: 100, bulkThreshold: 5, batchMax: 500, ...o })
const put = (p: Principal, body: unknown, build: Build = ON, s = stores) => call(p, { method: 'PUT', operation: TAG, body }, build, s).then(json)
const dbRow = () => db.prepare('SELECT enabled, per_day_max, units_max, bulk_threshold, batch_max, lowered_rev, rev, updated_by, updated_at_ms FROM permission_ceiling WHERE operation = ?').bind(TAG).first()
const ceilingLines = async (since: number) => (await linesSince(db, since)).filter(l => l.action === 'ceiling.changed')

beforeEach(async () => {
  await resetPermissions(db)
  await db.prepare("INSERT INTO members (id, kind, role, status, name, created_at_ms) VALUES (?, 'inhouse', NULL, 'active', 'Inhouse', 0) ON CONFLICT (id) DO NOTHING").bind(IH).run()
})

describe('who reaches the routes (failure 1)', () => {
  const row = (method: string, pattern: string) => accessMatrix.find(r => r.method === method && r.pattern === pattern)!
  it('the Inhouse team and admins read; a member is refused', () => {
    const get = row('GET', '/api/ceiling')
    expect(checkAccess(inhouse, get, undefined, NOW)).toEqual({ ok: true })
    expect(checkAccess(admin, get, undefined, NOW)).toEqual({ ok: true })
    expect(checkAccess(member, get, undefined, NOW)).toMatchObject({ refused: 'forbidden' })
  })
  it('only the Inhouse team writes, with no support grant needed; an admin and a member are refused', () => {
    const w = row('PUT', '/api/ceiling/:operation')
    expect(checkAccess(inhouse, w, undefined, NOW)).toEqual({ ok: true })
    expect(checkAccess(admin, w, undefined, NOW)).toMatchObject({ refused: 'forbidden' })
    expect(checkAccess(member, w, undefined, NOW)).toMatchObject({ refused: 'forbidden' })
  })
  it('a person who got past the matrix by a wiring bug fails loud and writes nothing', async () => {
    for (const p of [admin, member]) await expect(put(p, { ...values(), ifRev: null })).rejects.toThrow(/only the Inhouse team/)
    expect(await dbRow()).toBeNull()
  })
})

describe('editing is off in a product-shaped build (failure 2)', () => {
  it('the constant ships false', () => {
    expect(CEILING_EDIT_ON).toBe(false)
  })
  for (const [name, build] of [['the deployable build', { build: false, flag: '1' }], ['the test build switched off', { build: true, flag: undefined }], ['the test build with another flag', { build: true, flag: 'true' }]] as const) {
    it(`${name}: refused writes_off, nothing written, no line; the list says so and offers no edit`, async () => {
      const since = await lastLineId(db)
      const r = await put(inhouse, { ...values(), ifRev: null }, build)
      expect(r.status).toBe(403)
      expect(r.body).toEqual({ error: { code: 'forbidden', reason: 'writes_off' } })
      expect(await dbRow()).toBeNull()
      expect(await ceilingLines(since)).toEqual([])
      const list = await json(await call(inhouse, {}, build))
      expect(list.body).toMatchObject({ can: { edit: false }, writesOff: true })
    })
  }
})

describe('a change (failures 3 to 5)', () => {
  it('creates a row with ifRev null, then changes it at its rev; each change has its line with the old and new values', async () => {
    const since = await lastLineId(db)
    const made = await put(inhouse, { ...values(), ifRev: null })
    expect(made.status).toBe(200)
    expect(CeilingRowSchema.parse(made.body)).toMatchObject({ ...values(), operation: TAG, rev: 1, updatedBy: IH, updatedAt: { ms: NOW } })
    expect(await dbRow()).toMatchObject({ enabled: 1, per_day_max: 200, units_max: 100, lowered_rev: 1, rev: 1, updated_by: IH })
    const raised = await put(inhouse, { ...values({ perDayMax: 300 }), ifRev: 1 })
    expect(raised.status).toBe(200)
    expect(raised.body).toMatchObject({ perDayMax: 300, rev: 2 })
    const lines = await ceilingLines(since)
    expect(lines.map(l => [l.actor_id, JSON.parse(l.args_json)])).toEqual([
      [IH, { operation: TAG, old: null, new: values() }],
      [IH, { operation: TAG, old: values(), new: values({ perDayMax: 300 }) }],
    ])
  })

  it('a stale rev, or a create for a row that exists, changes nothing, writes no line and answers the row as it is', async () => {
    await put(inhouse, { ...values(), ifRev: null })
    const before = await dbRow()
    const since = await lastLineId(db)
    for (const ifRev of [null, 2, 7]) {
      const r = await put(inhouse, { ...values({ enabled: false }), ifRev })
      expect(r.status, String(ifRev)).toBe(409)
      expect((r.body.error as { code: string; current: CeilingRow }).code).toBe('conflict')
      expect(CeilingRowSchema.parse((r.body.error as { current: unknown }).current)).toMatchObject({ enabled: true, rev: 1 })
    }
    expect(await dbRow()).toEqual(before)
    expect(await ceilingLines(since)).toEqual([])
  })

  it('a rev given for an operation with no row is a conflict too, and creates nothing', async () => {
    const r = await put(inhouse, { ...values(), ifRev: 1 })
    expect(r.status).toBe(409)
    expect((r.body.error as { current: CeilingRow }).current).toMatchObject({ enabled: false, rev: null })
    expect(await dbRow()).toBeNull()
  })

  it('lowering any value raises lowered_rev once per change; raising or keeping one never does (failure 4)', async () => {
    await put(inhouse, { ...values(), ifRev: null })
    const lowered = async () => ((await dbRow()) as { lowered_rev: number }).lowered_rev
    let rev = 1
    const change = async (v: CeilingValues) => {
      const r = await put(inhouse, { ...v, ifRev: rev })
      expect(r.status, JSON.stringify(v)).toBe(200)
      rev += 1
    }
    const steps: [CeilingValues, number][] = [
      [values({ perDayMax: 199 }), 2], [values({ perDayMax: 400 }), 2], [values({ perDayMax: 400, unitsMax: 50 }), 3],
      [values({ perDayMax: 400, unitsMax: 50, bulkThreshold: 3 }), 4], [values({ perDayMax: 400, unitsMax: 50, bulkThreshold: 3, batchMax: 10 }), 5],
      [values({ perDayMax: 400, unitsMax: 50, bulkThreshold: 3, batchMax: 10 }), 5],
      [values({ enabled: false, perDayMax: 400, unitsMax: 50, bulkThreshold: 3, batchMax: 10 }), 6],
      [values({ enabled: true, perDayMax: 500, unitsMax: 60, bulkThreshold: 4, batchMax: 20 }), 6],
    ]
    for (const [v, want] of steps) {
      await change(v)
      expect(await lowered(), JSON.stringify(v)).toBe(want)
    }
  })

  it('a change whose line fails rolls back with it (failure 5)', async () => {
    const broken = openStores(env, brokenAudit)
    await expect(put(inhouse, { ...values(), ifRev: null }, ON, broken)).rejects.toThrow()
    expect(await dbRow()).toBeNull()
  })

  it('refuses a key that names no operation (404) and values outside the bounds (400), writing nothing', async () => {
    const nobody = await json(await call(inhouse, { method: 'PUT', operation: 'shopify.order.delete_all', body: { ...values(), ifRev: null } }))
    expect(nobody.status).toBe(404)
    for (const bad of [{ ...values({ bulkThreshold: 6 }), ifRev: null }, { ...values({ batchMax: 501 }), ifRev: null }, { ...values({ perDayMax: 0 }), ifRev: null }, { ...values(), ifRev: null, extra: 1 }, values()]) {
      expect((await put(inhouse, bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect(await dbRow()).toBeNull()
  })
})

describe('the list (failure 6)', () => {
  it('names every operation in the table, off with its suggested values until it has a row', async () => {
    const r = await json(await call(admin, {}))
    expect(r.status).toBe(200)
    const list = CeilingListSchema.parse(r.body)
    expect(list.items.map(i => i.operation)).toEqual(OPERATION_KEYS)
    for (const i of list.items) expect(i, i.operation).toMatchObject({ enabled: false, rev: null, updatedAt: null, updatedBy: null, perDayMax: i.suggested.perDayMax, unitsMax: i.suggested.unitsMax })
    const tag = list.items.find(i => i.operation === TAG)!
    expect(tag).toMatchObject({ title: 'Add tags to orders', tool: 'Shopify', measure: { kind: 'count', label: 'orders' }, applies: { perDay: true, batch: true }, guardrails: [], approverKind: 'person', suggested: { perDayMax: 200, unitsMax: 100 } })
    const post = list.items.find(i => i.operation === 'slack.channel.post')!
    expect(post).toMatchObject({ tool: 'Slack', measure: { kind: 'count', label: 'posts' }, applies: { perDay: true, batch: false } })
  })

  it('shows a row as it is, and offers editing to the Inhouse team only, only while editing is on', async () => {
    await put(inhouse, { ...values({ perDayMax: 120 }), ifRev: null })
    const forAdmin = CeilingListSchema.parse((await json(await call(admin, {}))).body)
    expect(forAdmin.items.find(i => i.operation === TAG)).toMatchObject({ enabled: true, perDayMax: 120, rev: 1 })
    expect([forAdmin.can.edit, forAdmin.writesOff]).toEqual([false, false])
    const forTeam = CeilingListSchema.parse((await json(await call(inhouse, {}))).body)
    expect([forTeam.can.edit, forTeam.writesOff]).toEqual([true, false])
  })
})
