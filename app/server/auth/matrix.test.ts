// checkAccess and canFor (p2-design section 3), failure modes as properties over every row and principal: Inhouse
// never reads brand_data without a live grant (a grant ending exactly at nowMs included) and always with the audit
// duty; nobody but the owner reaches `personal`; an Admin never writes technical except `tm:<id>:on` = 'off' through
// requireObject; canFor agrees with checkAccess. Then the matrix invariants, on the design's rows now and on the
// committed rows (server/access-matrix.ts) once PR0b fills them.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { accessMatrix } from '../access-matrix.ts'
import { routes } from '../routes.ts'
import type { Principal } from './principal.ts'
import { ADMIN_WRITE_OBJECT, AccessRefusedError, canFor, canRowsProblems, checkAccess, objectGate, rowFor } from './matrix.ts'
import type { AccessObject, AccessRow, CanRows } from './matrix.ts'
import { CanKeySchema } from '../../shared/contract/me.ts'
import { DESIGN_CAN_ROWS, DESIGN_ROWS, principals } from '../testing/auth-fixtures.ts'

const NOW = Date.parse('2026-11-20T10:00:00.000Z')
const row = fc.constantFrom(...DESIGN_ROWS)
const grant = fc.option(fc.record({ id: fc.constant('g_1'), endsAtMs: fc.integer({ min: NOW - 2, max: NOW + 2 }) }), { nil: null })
const memberId = fc.constantFrom('m_a', 'm_b', 'm_smoke')
const principal: fc.Arbitrary<Principal> = fc.oneof(
  fc.record({ kind: fc.constant('person' as const), memberId, role: fc.constantFrom('member' as const, 'admin' as const), subject: fc.constant('s'), requestId: fc.constant('r') }),
  fc.record({ kind: fc.constant('inhouse' as const), memberId: fc.constant('m_ih'), subject: fc.constant('s'), grant, requestId: fc.constant('r') }),
  fc.constant(principals.smoke()),
  fc.constant(principals.monitor()),
)
// A valid `tm:<id>:on` with something before or after it (`xtm:a:on`, `tm:a:onx`, a trailing newline): the anchors.
const anchorBreaking = fc.tuple(fc.constantFrom('', 'x', ' ', '\n', 'tm:', ':'), fc.constantFrom('tm:gpt:on', 'tm:a:on'), fc.constantFrom('', 'x', ' ', '\n', ':on', ':'))
  .map(([before, key, after]) => before + key + after)
/** The rule without a regex: three `:` parts, `tm`, a non-empty id, `on`. */
const isSwitchKey = (k: unknown) => {
  if (typeof k !== 'string') return false
  const parts = k.split(':')
  return parts.length === 3 && parts[0] === 'tm' && parts[1] !== '' && parts[2] === 'on'
}
const object: fc.Arbitrary<AccessObject | undefined> = fc.option(fc.record({
  ownerId: fc.option(memberId, { nil: undefined }),
  settingKey: fc.option(fc.oneof(fc.constantFrom('tm:gpt:on', 'tm:x:on', 'tm::on', 'tm:a:b:on', 'brand:name', 'tm:x:off'), anchorBreaking, fc.string()), { nil: undefined }),
  value: fc.option(fc.oneof(fc.constantFrom('off', 'on', 'OFF', false, 0), fc.anything()), { nil: undefined }),
}, { requiredKeys: [] }), { nil: undefined })
const ok = (d: ReturnType<typeof checkAccess>) => 'ok' in d && !d.objectCheck

describe('checkAccess properties', () => {
  test.prop([row, grant, object, fc.integer({ min: NOW - 2, max: NOW + 2 })])(
    'Inhouse never reads brand_data without a live grant, and always carries the audit duty when it does', (r, g, o, now) => {
      const d = checkAccess(principals.inhouse(g), r, o, now)
      if (r.class !== 'brand_data') return
      if (!g || g.endsAtMs <= now || r.method !== 'GET') expect('refused' in d).toBe(true)
      else expect(d).toEqual({ ok: true, audit: 'support.access' })
    })

  test.prop([principal, row, object])('audit is set exactly for Inhouse on brand_data', (p, r, o) => {
    const d = checkAccess(p, r, o, NOW)
    if ('ok' in d) expect(d.audit === 'support.access').toBe(p.kind === 'inhouse' && r.class === 'brand_data')
  })

  test.prop([principal, row, object])('nobody but the owner reaches personal, and never Inhouse or monitor', (p, r, o) => {
    fc.pre(r.class === 'personal')
    const d = checkAccess(p, r, o, NOW)
    if (!ok(d)) return
    expect(p.kind === 'inhouse' || (p.kind === 'service' && p.name === 'monitor')).toBe(false)
    expect(o?.ownerId).toBe('memberId' in p ? p.memberId : Symbol('none'))
  })

  test.prop([row, object])('an Admin never writes technical except tm:<id>:on = off, and only through requireObject', (r, o) => {
    fc.pre(r.class === 'technical' && r.method !== 'GET')
    const admin = principals.admin()
    const before = checkAccess(admin, r, undefined, NOW)
    expect(ok(before)).toBe(false)
    const gate = objectGate(admin, r, NOW)
    let passed = true
    try { gate.requireObject(o ?? {}) } catch (err) {
      expect(err).toBeInstanceOf(AccessRefusedError)
      passed = false
    }
    const allowed = !!r.adminWrite && isSwitchKey(o?.settingKey) && o?.value === 'off'
    expect(passed).toBe(allowed)
    expect(gate.passed).toBe(allowed)
  })

  test.prop([fc.oneof(anchorBreaking, fc.string()), fc.constantFrom('off', 'on')])('row 12 lets an Admin write exactly the keys tm:<id>:on, anchored', (key, value) => {
    const row12 = rowFor(DESIGN_ROWS, 'PUT', '/api/settings/technical/:key')!
    expect(ok(checkAccess(principals.admin(), row12, { settingKey: key, value }, NOW))).toBe(isSwitchKey(key) && value === 'off')
  })

  test.prop([principal, row, object])('Inhouse never writes brand_data, baseline or personal; monitor only reads open rows; smoke only reads', (p, r, o) => {
    const d = checkAccess(p, r, o, NOW)
    if (!('ok' in d)) return
    if (p.kind === 'inhouse') expect(r.method === 'GET' || r.class === 'technical' || r.class === 'report').toBe(true)
    if (p.kind === 'service' && p.name === 'monitor') expect(r.class === 'open' && r.method === 'GET').toBe(true)
    if (p.kind === 'service') expect(r.method).toBe('GET')
    if (r.class === 'open') expect(p.kind).toBe('service')
  })

  test.prop([principal, fc.integer({ min: NOW - 2, max: NOW + 2 })])('canFor agrees with checkAccess for every key', (p, now) => {
    const can = canFor(p, DESIGN_ROWS, DESIGN_CAN_ROWS, now)
    for (const key of CanKeySchema.options) {
      const want = DESIGN_CAN_ROWS[key]
      const r = rowFor(DESIGN_ROWS, want.method, want.pattern)!
      expect(can[key]).toBe(ok(checkAccess(p, r, want.as === 'adminWrite' ? ADMIN_WRITE_OBJECT : undefined, now)))
    }
  })
})

describe('checkAccess cases', () => {
  const r = (method: string, pattern: string) => rowFor(DESIGN_ROWS, method, pattern)!
  it('a grant ending exactly at nowMs is not live', () => {
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW }), r('GET', '/api/members'), undefined, NOW)).toEqual({ refused: 'forbidden', reason: 'grant_required' })
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), r('GET', '/api/members'), undefined, NOW)).toEqual({ ok: true, audit: 'support.access' })
  })
  it('a personal row asks for the object, then only the owner passes', () => {
    const row7 = r('PUT', '/api/settings/personal/:key')
    expect(checkAccess(principals.member('m_a'), row7, undefined, NOW)).toEqual({ ok: true, objectCheck: 'required' })
    expect(checkAccess(principals.member('m_a'), row7, { ownerId: 'm_a' }, NOW)).toEqual({ ok: true })
    expect(checkAccess(principals.member('m_a'), row7, { ownerId: 'm_b' }, NOW)).toEqual({ refused: 'forbidden', reason: 'not_owner' })
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), row7, { ownerId: 'm_ih' }, NOW)).toEqual({ refused: 'forbidden' })
  })
  it('an Admin on row 12 gets admin_read_only unless the object is tm:<id>:on = off', () => {
    const row12 = r('PUT', '/api/settings/technical/:key')
    expect(checkAccess(principals.admin(), row12, undefined, NOW)).toEqual({ ok: true, objectCheck: 'required' })
    expect(checkAccess(principals.admin(), row12, { settingKey: 'tm:gpt:on', value: 'off' }, NOW)).toEqual({ ok: true })
    expect(checkAccess(principals.admin(), row12, { settingKey: 'tm:gpt:on', value: 'on' }, NOW)).toEqual({ refused: 'forbidden', reason: 'admin_read_only' })
    expect(checkAccess(principals.member(), row12, { settingKey: 'tm:gpt:on', value: 'off' }, NOW)).toEqual({ refused: 'forbidden' })
    expect(checkAccess(principals.inhouse(), row12, undefined, NOW)).toEqual({ ok: true })
  })
  it('an adminWrite row without admin in allow never lets an Admin write', () => {
    const noAdmin: AccessRow = { method: 'PUT', pattern: '/x', class: 'technical', allow: ['inhouse'], adminWrite: true }
    expect(ok(checkAccess(principals.admin(), noAdmin, ADMIN_WRITE_OBJECT, NOW))).toBe(false)
  })
  it('row 21 (POST /api/client-error, report) lets Inhouse, Members and Admins post without a grant, never a service', () => {
    const row21 = r('POST', '/api/client-error')
    for (const p of [principals.inhouse(), principals.member(), principals.admin()]) expect(checkAccess(p, row21, undefined, NOW)).toEqual({ ok: true })
    for (const p of [principals.smoke(), principals.monitor()]) expect(checkAccess(p, row21, undefined, NOW)).toEqual({ refused: 'forbidden' })
  })
  it('a report row answers only POST, and only for the roles in allow', () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expect(checkAccess(principals.member(), { method, pattern: '/x', class: 'report', allow: ['member', 'admin', 'inhouse'] }, undefined, NOW)).toEqual({ refused: 'forbidden' })
    }
    const noInhouse: AccessRow = { method: 'POST', pattern: '/x', class: 'report', allow: ['member'] }
    expect(checkAccess(principals.inhouse(), noInhouse, undefined, NOW)).toEqual({ refused: 'forbidden' })
    expect(checkAccess(principals.admin(), noInhouse, undefined, NOW)).toEqual({ refused: 'forbidden' })
  })
  it('can: an Admin may switch a model off but not edit technical; Inhouse edits technical', () => {
    const admin = canFor(principals.admin(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(admin).toMatchObject({ switchModelOff: true, editTechnical: false, invite: true, grantSupport: true })
    const member = canFor(principals.member(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(Object.values(member).filter(Boolean)).toHaveLength(3) // viewMembers, viewAudit, exportAudit
    const inhouse = canFor(principals.inhouse(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(inhouse).toMatchObject({ editTechnical: true, viewMembers: false, invite: false })
  })
})

/** The section 3 invariants, run on a set of rows and its CanRows. */
function invariants(name: string, rows: readonly AccessRow[], canRows: CanRows | null) {
  describe(`matrix invariants: ${name}`, () => {
    it('every route has exactly one row (routes.ts, once PR0b fills it)', () => {
      for (const route of routes) expect(rows.filter(x => x.method === route.method && x.pattern === route.pattern)).toHaveLength(1)
      const keys = rows.map(x => `${x.method} ${x.pattern}`)
      expect(new Set(keys).size).toBe(keys.length)
    })
    it('no row lets Inhouse write brand_data, baseline or personal, and no personal row allows Inhouse', () => {
      const ih = principals.inhouse({ id: 'g', endsAtMs: Number.MAX_SAFE_INTEGER })
      for (const x of rows) {
        if (x.method !== 'GET' && x.class !== 'technical' && x.class !== 'report') expect(ok(checkAccess(ih, x, { ownerId: 'm_ih' }, NOW))).toBe(false)
        if (x.class === 'personal') expect(x.allow).not.toContain('inhouse')
      }
    })
    it('every technical row allows Inhouse; only adminWrite rows let an Admin write technical', () => {
      for (const x of rows.filter(y => y.class === 'technical')) {
        expect(x.allow).toContain('inhouse')
        if (x.method !== 'GET') expect(ok(checkAccess(principals.admin(), x, ADMIN_WRITE_OBJECT, NOW))).toBe(!!x.adminWrite)
        if (x.adminWrite) expect(x.allow).toContain('admin')
      }
    })
    it('no non-GET row outside technical and report lists inhouse; a report row is POST and names no service', () => {
      for (const x of rows) {
        if (x.method !== 'GET' && x.class !== 'technical' && x.class !== 'report') expect(x.allow, `${x.method} ${x.pattern}`).not.toContain('inhouse')
        if (x.class === 'report') {
          expect(x.method).toBe('POST')
          expect(x.services ?? []).toEqual([])
        }
      }
    })
    it('monitor only on open rows, smoke only on GET rows', () => {
      for (const x of rows) {
        if (x.services?.includes('monitor')) expect(x.class).toBe('open')
        if (x.services?.includes('smoke')) expect(x.method).toBe('GET')
      }
    })
    if (canRows) {
      it('every CanKey maps to exactly one existing row', () => {
        expect(Object.keys(canRows).sort()).toEqual([...CanKeySchema.options].sort())
        expect(canRowsProblems(rows, canRows)).toEqual([])
      })
    }
  })
}

invariants('the design rows (p2-design section 3)', DESIGN_ROWS, DESIGN_CAN_ROWS)
// The committed rows: empty until PR0b, then the real check. PR0b adds its canRows export here.
invariants('server/access-matrix.ts', accessMatrix, null)

describe('canRowsProblems', () => {
  it('fails on a missing row', () => {
    expect(canRowsProblems(DESIGN_ROWS.filter(r => !(r.method === 'POST' && r.pattern === '/api/grants')), DESIGN_CAN_ROWS)).toEqual(['grantSupport → POST /api/grants matches 0 rows'])
  })
  it('fails on a method mismatch', () => {
    const wrong: CanRows = { ...DESIGN_CAN_ROWS, editTechnical: { method: 'GET', pattern: '/api/settings/technical/:key' } }
    expect(canRowsProblems(DESIGN_ROWS, wrong)).toEqual(['editTechnical → GET /api/settings/technical/:key matches 0 rows'])
  })
  it('fails on a doubled row', () => {
    const invite = rowFor(DESIGN_ROWS, 'POST', '/api/members/invites')!
    expect(canRowsProblems([...DESIGN_ROWS, invite], DESIGN_CAN_ROWS)).toEqual(['invite → POST /api/members/invites matches 2 rows'])
  })
})
