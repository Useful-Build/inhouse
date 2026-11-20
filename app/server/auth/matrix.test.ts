// checkAccess and canFor (p2-design section 3), failure modes as properties over every row and principal: Inhouse
// never reads brand_data without a live grant (a grant ending exactly at nowMs included) and always with the audit
// duty; nobody but the owner reaches `personal`; an Admin never writes technical except `tm:<id>:on` = 'on' or 'off'
// through requireObject; canFor agrees with checkAccess. Then every row against every principal, from a table written
// by hand from decisions 19 and 27a (never read from the rows). Then the matrix invariants, on the design's rows now and on the
// committed rows (server/access-matrix.ts), which must equal the design's.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { accessMatrix, canRows as committedCanRows } from '../access-matrix.ts'
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

  test.prop([row, object])('an Admin never writes technical except tm:<id>:on = on or off, and only through requireObject', (r, o) => {
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
    const allowed = !!r.adminWrite && isSwitchKey(o?.settingKey) && (o?.value === 'off' || o?.value === 'on')
    expect(passed).toBe(allowed)
    expect(gate.passed).toBe(allowed)
  })

  test.prop([fc.oneof(anchorBreaking, fc.string()), fc.oneof(fc.constantFrom('off', 'on', 'OFF', 'On', ' on', null, true, false), fc.anything())])(
    'row 12 lets an Admin write exactly the keys tm:<id>:on, anchored, to exactly on or off', (key, value) => {
    const row12 = rowFor(DESIGN_ROWS, 'PUT', '/api/settings/technical/:key')!
    expect(ok(checkAccess(principals.admin(), row12, { settingKey: key, value }, NOW))).toBe(isSwitchKey(key) && (value === 'off' || value === 'on'))
  })

  test.prop([principal, row, object])('Inhouse never writes brand_data or personal, and a baseline row only where it lists inhouse; monitor only reads open rows; smoke only reads', (p, r, o) => {
    const d = checkAccess(p, r, o, NOW)
    if (!('ok' in d)) return
    if (p.kind === 'inhouse') expect(r.method === 'GET' || r.class === 'technical' || r.class === 'report' || (r.class === 'baseline' && r.allow.includes('inhouse'))).toBe(true)
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
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW }), r('GET', '/api/audit'), undefined, NOW)).toEqual({ refused: 'forbidden', reason: 'grant_required' })
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), r('GET', '/api/audit'), undefined, NOW)).toEqual({ ok: true, audit: 'support.access' })
  })
  it('a personal row asks for the object, then only the owner passes', () => {
    const row7 = r('PUT', '/api/settings/personal/:key')
    expect(checkAccess(principals.member('m_a'), row7, undefined, NOW)).toEqual({ ok: true, objectCheck: 'required' })
    expect(checkAccess(principals.member('m_a'), row7, { ownerId: 'm_a' }, NOW)).toEqual({ ok: true })
    expect(checkAccess(principals.member('m_a'), row7, { ownerId: 'm_b' }, NOW)).toEqual({ refused: 'forbidden', reason: 'not_owner' })
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), row7, { ownerId: 'm_ih' }, NOW)).toEqual({ refused: 'forbidden' })
  })
  it('an Admin on row 12 gets admin_read_only unless the object is tm:<id>:on = on or off', () => {
    const row12 = r('PUT', '/api/settings/technical/:key')
    expect(checkAccess(principals.admin(), row12, undefined, NOW)).toEqual({ ok: true, objectCheck: 'required' })
    expect(checkAccess(principals.admin(), row12, { settingKey: 'tm:gpt:on', value: 'off' }, NOW)).toEqual({ ok: true })
    expect(checkAccess(principals.admin(), row12, { settingKey: 'tm:gpt:on', value: 'on' }, NOW)).toEqual({ ok: true })
    expect(checkAccess(principals.admin(), row12, { settingKey: 'tm:gpt:on', value: null }, NOW)).toEqual({ refused: 'forbidden', reason: 'admin_read_only' })
    expect(checkAccess(principals.admin(), row12, { settingKey: 'tm:gpt:effort', value: 'on' }, NOW)).toEqual({ refused: 'forbidden', reason: 'admin_read_only' })
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
  it('can: an Admin may switch a model but not edit technical; Inhouse has every Admin control but granting, and the audit log only under a grant', () => {
    const admin = canFor(principals.admin(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(admin).toMatchObject({ switchModel: true, editTechnical: false, invite: true, grantSupport: true })
    const member = canFor(principals.member(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(Object.values(member).filter(Boolean)).toHaveLength(3) // viewMembers, viewAudit, exportAudit
    const inhouse = canFor(principals.inhouse(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(inhouse).toEqual({
      invite: true, changeRole: true, remove: true, editBrandSettings: true, editTechnical: true, switchModel: true, grantSupport: false,
      viewMembers: true, viewAudit: false, exportAudit: false,
    })
    const granted = canFor(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(granted).toMatchObject({ grantSupport: false, viewAudit: true, exportAudit: true })
  })
})

/**
 * Every row against every principal, written by hand from decisions 19 and 27a (the Inhouse team holds every Admin
 * control but granting itself access; a brand's audit log needs a live grant; personal stays the owner's). Columns:
 * Member, Admin, Inhouse without a grant, Inhouse with a live grant, smoke, monitor. `ok` passes; `obj` passes only
 * through requireObject; `no` is a bare forbidden; `grant` is grant_required; `audit` passes with the support.access duty.
 */
type Want = 'ok' | 'obj' | 'no' | 'grant' | 'audit'
const ORACLE: Record<string, readonly [Want, Want, Want, Want, Want, Want]> = {
  'GET /api/health': ['no', 'no', 'no', 'no', 'no', 'ok'],
  'GET /api/me': ['ok', 'ok', 'ok', 'ok', 'ok', 'no'],
  'GET /api/members': ['ok', 'ok', 'ok', 'ok', 'no', 'no'],
  'POST /api/members/invites': ['no', 'ok', 'ok', 'ok', 'no', 'no'],
  'PUT /api/members/:id/role': ['no', 'ok', 'ok', 'ok', 'no', 'no'],
  'DELETE /api/members/:id': ['no', 'ok', 'ok', 'ok', 'no', 'no'],
  'GET /api/settings/personal': ['obj', 'obj', 'no', 'no', 'obj', 'no'],
  'PUT /api/settings/personal/:key': ['obj', 'obj', 'no', 'no', 'no', 'no'],
  'GET /api/settings/brand': ['ok', 'ok', 'ok', 'ok', 'ok', 'no'],
  'PUT /api/settings/brand/:key': ['no', 'ok', 'ok', 'ok', 'no', 'no'],
  'GET /api/settings/technical': ['ok', 'ok', 'ok', 'ok', 'no', 'no'],
  'PUT /api/settings/technical/:key': ['no', 'obj', 'ok', 'ok', 'no', 'no'],
  'PUT /api/photo': ['obj', 'obj', 'no', 'no', 'no', 'no'],
  'DELETE /api/photo': ['obj', 'obj', 'no', 'no', 'no', 'no'],
  'GET /api/members/:id/photo': ['ok', 'ok', 'ok', 'ok', 'no', 'no'],
  'GET /api/grants': ['no', 'ok', 'ok', 'ok', 'no', 'no'],
  'POST /api/grants': ['no', 'ok', 'no', 'no', 'no', 'no'],
  'POST /api/grants/:id/end': ['no', 'ok', 'no', 'no', 'no', 'no'],
  'GET /api/audit': ['ok', 'ok', 'grant', 'audit', 'no', 'no'],
  'GET /api/audit/export.csv': ['ok', 'ok', 'grant', 'audit', 'no', 'no'],
  'POST /api/client-error': ['ok', 'ok', 'ok', 'ok', 'no', 'no'],
}
const DECISION: Record<Want, ReturnType<typeof checkAccess>> = {
  ok: { ok: true }, obj: { ok: true, objectCheck: 'required' }, no: { refused: 'forbidden' },
  grant: { refused: 'forbidden', reason: 'grant_required' }, audit: { ok: true, audit: 'support.access' },
}
const COLUMNS: readonly [string, () => Principal][] = [
  ['member', () => principals.member()], ['admin', () => principals.admin()], ['inhouse', () => principals.inhouse()],
  ['inhouse with a grant', () => principals.inhouse({ id: 'g', endsAtMs: NOW + 1 })], ['smoke', principals.smoke], ['monitor', principals.monitor],
]

describe('every row against every principal (the hand-written oracle)', () => {
  for (const [name, rows] of [['the design rows', DESIGN_ROWS], ['server/access-matrix.ts', accessMatrix]] as const) {
    it(`${name}: each row has an oracle line, and checkAccess answers it for each principal`, () => {
      for (const x of rows) {
        const key = `${x.method} ${x.pattern}`
        const want = ORACLE[key]
        expect(want, `${key} has no oracle line`).toBeDefined()
        COLUMNS.forEach(([who, p], i) => expect(checkAccess(p(), x, undefined, NOW), `${key} as ${who}`).toEqual(DECISION[want[i]]))
      }
      expect(rows.map(x => `${x.method} ${x.pattern}`).sort()).toEqual(Object.keys(ORACLE).sort())
    })
  }
})

/** Rows outside technical, report and baseline that list Inhouse on a non-GET method (brand_data and personal). */
const inhouseWriteProblems = (rows: readonly AccessRow[]) =>
  rows.filter(x => x.method !== 'GET' && (x.class === 'brand_data' || x.class === 'personal') && x.allow.includes('inhouse')).map(x => `${x.method} ${x.pattern}`)

/** The Inhouse team never grants itself access (decision 19), and the audit log is never baseline (BD7). */
const GRANT_WRITES = ['POST /api/grants', 'POST /api/grants/:id/end']
const BRAND_DATA_READS = ['GET /api/audit', 'GET /api/audit/export.csv']
const grantProblems = (rows: readonly AccessRow[]) => [
  ...rows.filter(x => GRANT_WRITES.includes(`${x.method} ${x.pattern}`) && x.allow.includes('inhouse')).map(x => `${x.method} ${x.pattern} lists inhouse`),
  ...rows.filter(x => BRAND_DATA_READS.includes(`${x.method} ${x.pattern}`) && x.class !== 'brand_data').map(x => `${x.method} ${x.pattern} is ${x.class}`),
]

/**
 * Pairs of routes with the same method where one concrete path matches both (equal length, every segment literal-equal
 * or a `:param` on either side). api.ts takes the access row from the pattern matchRoute found first, so a shadowed
 * route would be served under the other route's row.
 */
const shadowProblems = (table: readonly { method: string; pattern: string }[]) => {
  const problems: string[] = []
  table.forEach((a, i) => table.slice(i + 1).forEach(b => {
    if (a.method !== b.method) return
    const x = a.pattern.split('/'), y = b.pattern.split('/')
    if (x.length === y.length && x.every((seg, k) => seg === y[k] || seg.startsWith(':') || y[k].startsWith(':'))) problems.push(`${a.method} ${a.pattern} / ${b.pattern}`)
  }))
  return problems
}

/** The closed list of `open` rows (matrix.ts): only the health check. */
const OPEN_ROWS = ['GET /api/health']
const openProblems = (rows: readonly AccessRow[]) => {
  const keys = rows.filter(x => x.class === 'open').map(x => `${x.method} ${x.pattern}`)
  return [...keys.filter(k => !OPEN_ROWS.includes(k)).map(k => `${k} is open`), ...OPEN_ROWS.filter(k => !keys.includes(k)).map(k => `${k} is not open`)]
}

/** The closed list of `report` rows (matrix.ts): only the error reporter's POST. */
const REPORT_ROWS = ['POST /api/client-error']
const reportProblems = (rows: readonly AccessRow[]) => {
  const report = rows.filter(x => x.class === 'report')
  const keys = report.map(x => `${x.method} ${x.pattern}`)
  const problems = keys.filter(k => !REPORT_ROWS.includes(k)).map(k => `${k} is report`)
  // An empty table needs no report row; a filled one needs every listed row as report.
  if (rows.length) for (const k of REPORT_ROWS) if (!keys.includes(k)) problems.push(`${k} is not report`)
  for (const x of report) if ((x.services ?? []).length) problems.push(`${x.method} ${x.pattern} names a service`)
  return problems
}

describe('the invariant checks catch a bad row', () => {
  it('report on POST /api/members/invites, client-error not report, or a report row naming a service', () => {
    const invites = rowFor(DESIGN_ROWS, 'POST', '/api/members/invites')!
    const bad = DESIGN_ROWS.map(r => (r === invites ? { ...r, class: 'report' as const } : r))
    expect(reportProblems(bad)).toEqual(['POST /api/members/invites is report'])
    const withService = DESIGN_ROWS.map(r => (r.class === 'report' ? { ...r, services: ['smoke' as const] } : r))
    expect(reportProblems(withService)).toEqual(['POST /api/client-error names a service'])
    const demoted = DESIGN_ROWS.map(r => (r.class === 'report' ? { ...r, class: 'baseline' as const } : r))
    expect(reportProblems(demoted)).toEqual(['POST /api/client-error is not report'])
    expect(reportProblems(DESIGN_ROWS)).toEqual([])
  })
  it('open on GET /api/members, or health not open', () => {
    const members = rowFor(DESIGN_ROWS, 'GET', '/api/members')!
    expect(openProblems(DESIGN_ROWS.map(r => (r === members ? { ...r, class: 'open' as const } : r)))).toEqual(['GET /api/members is open'])
    expect(openProblems(DESIGN_ROWS.map(r => (r.class === 'open' ? { ...r, class: 'baseline' as const } : r)))).toEqual(['GET /api/health is not open'])
    expect(openProblems(DESIGN_ROWS)).toEqual([])
  })
  it('a route that shadows another: GET /api/members/:id beside GET /api/members/invites', () => {
    expect(shadowProblems([{ method: 'GET', pattern: '/api/members/invites' }, { method: 'GET', pattern: '/api/members/:id' }])).toEqual(['GET /api/members/invites / /api/members/:id'])
    expect(shadowProblems([{ method: 'POST', pattern: '/api/members/invites' }, { method: 'GET', pattern: '/api/members/:id' }])).toEqual([])
  })
  it('a non-GET brand_data or personal row listing inhouse', () => {
    const invites = rowFor(DESIGN_ROWS, 'POST', '/api/members/invites')!
    const photo = rowFor(DESIGN_ROWS, 'PUT', '/api/photo')!
    const bad = DESIGN_ROWS.map(r => (r === invites ? { ...r, class: 'brand_data' as const } : r === photo ? { ...r, allow: [...r.allow, 'inhouse' as const] } : r))
    expect(inhouseWriteProblems(bad)).toEqual(['POST /api/members/invites', 'PUT /api/photo'])
    expect(inhouseWriteProblems(DESIGN_ROWS)).toEqual([])
  })
  it('a grant row listing inhouse, or an audit row that is not brand_data', () => {
    const create = rowFor(DESIGN_ROWS, 'POST', '/api/grants')!
    const audit = rowFor(DESIGN_ROWS, 'GET', '/api/audit')!
    const bad = DESIGN_ROWS.map(r => (r === create ? { ...r, allow: [...r.allow, 'inhouse' as const] } : r === audit ? { ...r, class: 'baseline' as const } : r))
    expect(grantProblems(bad)).toEqual(['POST /api/grants lists inhouse', 'GET /api/audit is baseline'])
    expect(grantProblems(DESIGN_ROWS)).toEqual([])
  })
})

/** The section 3 invariants, run on a set of rows and its CanRows. */
function invariants(name: string, rows: readonly AccessRow[], canRows: CanRows | null) {
  describe(`matrix invariants: ${name}`, () => {
    it('every route has exactly one row (routes.ts)', () => {
      for (const route of routes) expect(rows.filter(x => x.method === route.method && x.pattern === route.pattern)).toHaveLength(1)
      const keys = rows.map(x => `${x.method} ${x.pattern}`)
      expect(new Set(keys).size).toBe(keys.length)
    })
    it('every row has exactly one route (routes.ts)', () => {
      for (const x of rows) expect(routes.filter(r => r.method === x.method && r.pattern === x.pattern), `${x.method} ${x.pattern}`).toHaveLength(1)
    })
    it('the open rows are exactly GET /api/health (a closed list)', () => {
      expect(openProblems(rows)).toEqual([])
    })
    it('no row lets Inhouse write brand_data or personal, and no personal row allows Inhouse', () => {
      const ih = principals.inhouse({ id: 'g', endsAtMs: Number.MAX_SAFE_INTEGER })
      for (const x of rows) {
        if (x.method !== 'GET' && (x.class === 'brand_data' || x.class === 'personal')) expect(ok(checkAccess(ih, x, { ownerId: 'm_ih' }, NOW))).toBe(false)
        if (x.class === 'personal') expect(x.allow).not.toContain('inhouse')
      }
    })
    it('Inhouse never creates or ends a grant, and the audit log stays brand_data', () => {
      expect(grantProblems(rows)).toEqual([])
    })
    it('every technical row allows Inhouse; only adminWrite rows let an Admin write technical', () => {
      for (const x of rows.filter(y => y.class === 'technical')) {
        expect(x.allow).toContain('inhouse')
        if (x.method !== 'GET') expect(ok(checkAccess(principals.admin(), x, ADMIN_WRITE_OBJECT, NOW))).toBe(!!x.adminWrite)
        if (x.adminWrite) expect(x.allow).toContain('admin')
      }
    })
    it('no non-GET brand_data or personal row lists inhouse', () => {
      expect(inhouseWriteProblems(rows)).toEqual([])
    })
    it('the report rows are exactly POST /api/client-error (a closed list), naming no service', () => {
      expect(reportProblems(rows)).toEqual([])
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
invariants('server/access-matrix.ts', accessMatrix, committedCanRows)

describe('the committed routes', () => {
  it('no two routes with the same method match one concrete path (api.ts reads the row of the matched pattern)', () => {
    expect(shadowProblems(routes)).toEqual([])
  })
})

describe('the committed rows are the design', () => {
  it('server/access-matrix.ts equals DESIGN_ROWS and DESIGN_CAN_ROWS (the fixture is the independent copy)', () => {
    expect(accessMatrix).toStrictEqual(DESIGN_ROWS)
    expect(committedCanRows).toStrictEqual(DESIGN_CAN_ROWS)
  })
})

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
