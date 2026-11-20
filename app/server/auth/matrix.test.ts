// checkAccess and canFor (p2-design section 3), failure modes as properties over every row and principal: Inhouse
// never reads brand_data without a live grant (a grant ending exactly at nowMs included) and always with the audit
// duty; nobody but the owner reaches `personal`; an Admin never writes technical except `tm:<id>:on` = 'off' through
// requireObject; canFor agrees with checkAccess. Then the matrix invariants, on the design's rows now and on the
// committed rows (server/access-matrix.ts), which must equal the design's.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { accessMatrix, canRows as committedCanRows } from '../access-matrix.ts'
import { routes } from '../routes.ts'
import type { Principal } from './principal.ts'
import { ADMIN_WRITE_OBJECT, AccessRefusedError, canFor, canRowsProblems, checkAccess, objectGate, rowFor } from './matrix.ts'
import type { AccessObject, AccessRow, CanRows } from './matrix.ts'
import { CanKeySchema } from '../../shared/contract/me.ts'
import { DESIGN_CAN_ROWS, DESIGN_ROWS, SMOKE_MEMBER, principals } from '../testing/auth-fixtures.ts'

const NOW = Date.parse('2026-11-20T10:00:00.000Z')
const row = fc.constantFrom(...DESIGN_ROWS)
const grant = fc.option(fc.record({ id: fc.constant('g_1'), endsAtMs: fc.integer({ min: NOW - 2, max: NOW + 2 }) }), { nil: null })
const memberId = fc.constantFrom('m_a', 'm_b', 'm_smoke')
const principal: fc.Arbitrary<Principal> = fc.oneof(
  fc.record({ kind: fc.constant('person' as const), memberId, role: fc.constantFrom('member' as const, 'admin' as const), subject: fc.constant('s'), requestId: fc.constant('r'), expMs: fc.constant(NOW + 600_000) }),
  fc.record({ kind: fc.constant('inhouse' as const), memberId: fc.constant('m_ih'), subject: fc.constant('s'), grant, requestId: fc.constant('r'), expMs: fc.constant(NOW + 600_000) }),
  fc.constant(principals.smoke()),
  fc.constant(principals.monitor()),
  fc.constant(principals.release()),
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

  // Changed in P3 (p3-design section 3): "smoke only reads" became "smoke only on rows that list it, never open or
  // report"; release reaches only open rows that list it.
  test.prop([principal, row, object])('Inhouse never writes brand_data, baseline or personal; monitor only reads open rows; smoke and release only where listed', (p, r, o) => {
    const d = checkAccess(p, r, o, NOW)
    if (!('ok' in d)) return
    if (p.kind === 'inhouse') expect(r.method === 'GET' || r.class === 'technical' || r.class === 'report').toBe(true)
    if (p.kind === 'service' && p.name === 'monitor') expect(r.class === 'open' && r.method === 'GET').toBe(true)
    if (p.kind === 'service' && p.name === 'release') expect(r.class).toBe('open')
    if (p.kind === 'service' && p.name === 'smoke') expect(r.class !== 'open' && r.class !== 'report').toBe(true)
    if (p.kind === 'service') expect(r.services).toContain(p.name)
    if (r.class === 'open') expect(p.kind).toBe('service')
  })

  test.prop([principal, row, object])('on an ownerObject row a person or smoke passes only with its own object; Inhouse only with a live grant', (p, r, o) => {
    fc.pre(r.ownerObject === true)
    const d = checkAccess(p, r, o, NOW)
    if (!ok(d)) return
    if (p.kind === 'inhouse') expect(p.grant !== null && p.grant.endsAtMs > NOW).toBe(true)
    else expect(o?.ownerId).toBe('memberId' in p ? p.memberId : Symbol('none'))
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

/** Rows outside technical and report that list Inhouse on a non-GET method. */
const inhouseWriteProblems = (rows: readonly AccessRow[]) =>
  rows.filter(x => x.method !== 'GET' && x.class !== 'technical' && x.class !== 'report' && x.allow.includes('inhouse')).map(x => `${x.method} ${x.pattern}`)

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

/** The closed list of `open` rows (matrix.ts): the health check, and P3's drain and warm-up (p3-design section 3). */
const OPEN_ROWS = ['GET /api/health', 'POST /api/ops/drain', 'GET /api/ops/drain', 'POST /api/ops/warmup']
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
  it('open on GET /api/members, or health, drain or warm-up not open', () => {
    const members = rowFor(DESIGN_ROWS, 'GET', '/api/members')!
    expect(openProblems(DESIGN_ROWS.map(r => (r === members ? { ...r, class: 'open' as const } : r)))).toEqual(['GET /api/members is open'])
    expect(openProblems(DESIGN_ROWS.map(r => (r.class === 'open' ? { ...r, class: 'baseline' as const } : r)))).toEqual(['GET /api/health is not open', 'POST /api/ops/drain is not open', 'GET /api/ops/drain is not open', 'POST /api/ops/warmup is not open'])
    expect(openProblems(DESIGN_ROWS)).toEqual([])
  })
  it('a route that shadows another: GET /api/members/:id beside GET /api/members/invites', () => {
    expect(shadowProblems([{ method: 'GET', pattern: '/api/members/invites' }, { method: 'GET', pattern: '/api/members/:id' }])).toEqual(['GET /api/members/invites / /api/members/:id'])
    expect(shadowProblems([{ method: 'POST', pattern: '/api/members/invites' }, { method: 'GET', pattern: '/api/members/:id' }])).toEqual([])
  })
  it('a non-GET brand_data, baseline or personal row listing inhouse', () => {
    const invites = rowFor(DESIGN_ROWS, 'POST', '/api/members/invites')!
    const bad = DESIGN_ROWS.map(r => (r === invites ? { ...r, allow: [...r.allow, 'inhouse' as const] } : r))
    expect(inhouseWriteProblems(bad)).toEqual(['POST /api/members/invites'])
    expect(inhouseWriteProblems(DESIGN_ROWS)).toEqual([])
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
    it('the open rows are exactly health, drain and warm-up (a closed list)', () => {
      expect(openProblems(rows)).toEqual([])
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
    it('no non-GET row outside technical and report lists inhouse', () => {
      expect(inhouseWriteProblems(rows)).toEqual([])
    })
    it('the report rows are exactly POST /api/client-error (a closed list), naming no service', () => {
      expect(reportProblems(rows)).toEqual([])
    })
    // Changed in P3: "smoke only on GET rows" became "smoke never on open or report rows" (p3-design section 3).
    it('monitor only on open GET rows, release only on open rows, smoke never on open or report rows; each open row names one service', () => {
      for (const x of rows) {
        if (x.services?.includes('monitor')) expect(x.class === 'open' && x.method === 'GET').toBe(true)
        if (x.services?.includes('release')) expect(x.class).toBe('open')
        if (x.services?.includes('smoke')) expect(x.class !== 'open' && x.class !== 'report').toBe(true)
        if (x.class === 'open') expect(x.services ?? []).toHaveLength(1)
      }
    })
    it('ownerObject only on brand_data rows', () => {
      for (const x of rows) if (x.ownerObject) expect(x.class, `${x.method} ${x.pattern}`).toBe('brand_data')
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

// P3 (p3-design section 3), each failure mode against literal rows written here, never read from the matrix.
describe('P3 auth: release, smoke and ownerObject', () => {
  const key = (r: AccessRow) => `${r.method} ${r.pattern}`
  /** The rows the release job may call, and the ones smoke may call, as section 3's table lists them. */
  const RELEASE_ROWS = ['POST /api/ops/drain', 'GET /api/ops/drain', 'POST /api/ops/warmup']
  const SMOKE_ROWS = [
    'GET /api/me', 'GET /api/settings/personal', 'GET /api/settings/brand',
    'GET /api/chats', 'POST /api/chats', 'GET /api/chats/:id', 'POST /api/chats/:id/turns', 'GET /api/runs/active', 'GET /api/socket', 'GET /api/models',
  ]
  const OWNER_OBJECT_ROWS = ['GET /api/chats', 'GET /api/chats/:id', 'GET /api/runs/active', 'GET /api/traces/:id', 'GET /api/socket', 'GET /api/chats/:id/files']
  const withObject = (p: Principal, r: AccessRow, o?: AccessObject) => {
    const gate = objectGate(p, r, NOW)
    const d = checkAccess(p, r, undefined, NOW)
    if ('refused' in d) return false
    if (!d.objectCheck) return true
    try { gate.requireObject(o ?? {}) } catch { return false }
    return gate.passed
  }

  for (const rows of [DESIGN_ROWS, accessMatrix]) {
    const name = rows === DESIGN_ROWS ? 'the design rows' : 'server/access-matrix.ts'
    it(`${name}: a release token reaches exactly drain and warm-up, any method, with no object`, () => {
      expect(rows.filter(r => ok(checkAccess(principals.release(), r, undefined, NOW))).map(key)).toEqual(RELEASE_ROWS)
    })
    it(`${name}: smoke reaches exactly its rows, and on personal and ownerObject rows only its own object`, () => {
      expect(rows.filter(r => withObject(principals.smoke(), r, { ownerId: SMOKE_MEMBER })).map(key)).toEqual(SMOKE_ROWS)
      for (const r of rows.filter(x => SMOKE_ROWS.includes(key(x)))) {
        const d = checkAccess(principals.smoke(), r, undefined, NOW)
        const owned = r.class === 'personal' || r.ownerObject === true
        expect(d, key(r)).toEqual(owned ? { ok: true, objectCheck: 'required' } : { ok: true })
        if (owned) expect(checkAccess(principals.smoke(), r, { ownerId: 'm_a' }, NOW), key(r)).toEqual({ refused: 'forbidden', reason: 'not_owner' })
      }
    })
    it(`${name}: the ownerObject rows are the chat reads, and each asks persons for the object`, () => {
      expect(rows.filter(r => r.ownerObject).map(key)).toEqual(OWNER_OBJECT_ROWS)
      for (const r of rows.filter(x => x.ownerObject)) {
        for (const p of [principals.member('m_a'), principals.admin('m_a')]) {
          expect(checkAccess(p, r, undefined, NOW), key(r)).toEqual({ ok: true, objectCheck: 'required' })
          expect(checkAccess(p, r, { ownerId: 'm_a' }, NOW), key(r)).toEqual({ ok: true })
          expect(checkAccess(p, r, { ownerId: 'm_b' }, NOW), key(r)).toEqual({ refused: 'forbidden', reason: 'not_owner' })
          expect(checkAccess(p, r, {}, NOW), key(r)).toEqual({ refused: 'forbidden', reason: 'not_owner' })
        }
      }
    })
  }

  it('an Admin gets no more than a Member on another member\'s chat (BD11)', () => {
    const r = rowFor(DESIGN_ROWS, 'GET', '/api/chats/:id')!
    expect(withObject(principals.admin('m_admin'), r, { ownerId: 'm_member' })).toBe(false)
    expect(withObject(principals.member('m_member'), r, { ownerId: 'm_member' })).toBe(true)
  })

  it('Inhouse under a live grant passes an ownerObject row without an owner, with the audit duty; without one never', () => {
    const r = rowFor(DESIGN_ROWS, 'GET', '/api/chats/:id')!
    const live = principals.inhouse({ id: 'g', endsAtMs: NOW + 1 })
    expect(checkAccess(live, r, undefined, NOW)).toEqual({ ok: true, audit: 'support.access' })
    const gate = objectGate(live, r, NOW)
    gate.requireObject({ ownerId: 'm_member' })
    expect(gate.passed).toBe(true)
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW }), r, undefined, NOW)).toEqual({ refused: 'forbidden', reason: 'grant_required' })
    expect(checkAccess(principals.inhouse(null), r, undefined, NOW)).toEqual({ refused: 'forbidden', reason: 'grant_required' })
  })

  it('release and monitor reach nothing a person does; a person and Inhouse never reach drain or warm-up', () => {
    for (const r of DESIGN_ROWS.filter(x => RELEASE_ROWS.includes(key(x)))) {
      for (const p of [principals.member(), principals.admin(), principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), principals.smoke(), principals.monitor()]) {
        expect(checkAccess(p, r, { ownerId: 'memberId' in p ? p.memberId : 'x' }, NOW), `${p.kind} ${key(r)}`).toEqual({ refused: 'forbidden' })
      }
    }
    expect(checkAccess(principals.release(), rowFor(DESIGN_ROWS, 'GET', '/api/health')!, undefined, NOW)).toEqual({ refused: 'forbidden' })
  })
})
