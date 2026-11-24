// checkAccess and canFor (p2-design section 3), failure modes as properties over every row and principal: Inhouse
// never reads brand_data without a live grant (a grant ending exactly at nowMs included) and always with the audit
// duty; nobody but the owner reaches `personal`; an Admin never writes technical except `tm:<id>:on` = 'on' or 'off'
// through requireObject; canFor agrees with checkAccess. Then every row against every principal, from a table written
// by hand from decisions 19 and 27a (never read from the rows). Then the matrix invariants, on the design's rows now and on the
// committed rows (server/access-matrix.ts), which must equal the design's.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { accessMatrix, canRows as committedCanRows } from '../access-matrix.ts'
import { routes as signedInRoutes, webhookRoutes } from '../routes.ts'

/** Every route: the signed-in table and P8a F2's webhook routes (the closed exception outside sign-in). */
const routes = [...signedInRoutes, ...webhookRoutes]
import type { Principal } from './principal.ts'
import { ADMIN_WRITE_OBJECT, AccessRefusedError, canFor, canRowsProblems, checkAccess, objectGate, rowFor } from './matrix.ts'
import type { AccessObject, AccessRow, CanRows } from './matrix.ts'
import { CanKeySchema } from '../../shared/contract/me.ts'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'
import { DESIGN_CAN_ROWS, DESIGN_ROWS, SMOKE_MEMBER, principals } from '../testing/auth-fixtures.ts'
import { INHOUSE_BRAND_WRITES } from '../testing/inhouse-brand-writes.ts'

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
/**
 * Item 19 (2026-11-20): a brand_data write row that lists inhouse (row 45 once the orchestrator lists inhouse on it).
 * Written here as a literal, so the properties below run on a write row whatever the committed rows hold.
 */
const BRAND_WRITE_ROW: AccessRow = { method: 'PUT', pattern: '/api/memory/brand/:id/forgotten', class: 'brand_data', allow: ['admin', 'inhouse'] }
const rowOrWrite = fc.constantFrom(...DESIGN_ROWS, BRAND_WRITE_ROW)

describe('checkAccess properties', () => {
  // Changed for item 19: "only on GET" became "only on a row that lists inhouse" (reads and writes); the grant and the
  // audit duty are unchanged, and the arbitrary now includes a literal brand_data write row that lists inhouse.
  test.prop([rowOrWrite, grant, object, fc.integer({ min: NOW - 2, max: NOW + 2 })])(
    'Inhouse never reads or writes brand_data without a live grant, and always carries the audit duty when it does', (r, g, o, now) => {
      const d = checkAccess(principals.inhouse(g), r, o, now)
      if (r.class !== 'brand_data') return
      if (!g || g.endsAtMs <= now || !r.allow.includes('inhouse')) expect('refused' in d).toBe(true)
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

  // Changed in P3 (p3-design section 3): "smoke only reads" became "smoke only on rows that list it, never open or
  // report"; release reaches only open rows that list it. Changed for decision 19: Inhouse may write a baseline row
  // that lists it.
  // Changed for item 19: Inhouse may also write a brand_data row that lists it, and only under a live grant with the
  // audit duty (the arbitrary includes a literal such row).
  test.prop([principal, rowOrWrite, object])('Inhouse never writes personal, brand_data only where it lists inhouse and under a grant, and a baseline row only where it lists inhouse; monitor only reads open rows; smoke and release only where listed', (p, r, o) => {
    const d = checkAccess(p, r, o, NOW)
    if (!('ok' in d)) return
    if (p.kind === 'inhouse') expect(r.method === 'GET' || r.class === 'technical' || r.class === 'report' || (r.class === 'baseline' && r.allow.includes('inhouse')) || (r.class === 'brand_data' && r.allow.includes('inhouse') && d.audit === 'support.access')).toBe(true)
    if (p.kind === 'inhouse' && r.class === 'personal') expect.unreachable('Inhouse reached a personal row')
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
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW }), r('GET', '/api/audit'), undefined, NOW)).toEqual({ refused: 'forbidden', reason: 'grant_required' })
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), r('GET', '/api/audit'), undefined, NOW)).toEqual({ ok: true, audit: 'support.access' })
  })
  it('item 19: a brand_data write row that lists inhouse takes Inhouse only under a live grant, with the audit duty', () => {
    const forget = BRAND_WRITE_ROW
    expect(checkAccess(principals.inhouse(), forget, undefined, NOW)).toEqual({ refused: 'forbidden', reason: 'grant_required' })
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW }), forget, undefined, NOW)).toEqual({ refused: 'forbidden', reason: 'grant_required' })
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), forget, undefined, NOW)).toEqual({ ok: true, audit: 'support.access' })
    expect(checkAccess(principals.admin(), forget, undefined, NOW)).toEqual({ ok: true })
    expect(checkAccess(principals.member(), forget, undefined, NOW)).toEqual({ refused: 'forbidden' })
    expect(checkAccess(principals.smoke(), forget, undefined, NOW)).toEqual({ refused: 'forbidden' })
    // The same write row without inhouse in `allow` (row 45 as committed today): refused even under a live grant.
    const adminOnly: AccessRow = { ...forget, allow: ['admin'] }
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), adminOnly, undefined, NOW)).toEqual({ refused: 'forbidden' })
    // A personal write row stays the owner's, even if a row ever listed inhouse.
    const personalListing: AccessRow = { method: 'PUT', pattern: '/api/memory/personal/:id/forgotten', class: 'personal', allow: ['member', 'admin', 'inhouse'] }
    expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), personalListing, { ownerId: 'm_ih' }, NOW)).toEqual({ refused: 'forbidden' })
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
    expect(admin).toMatchObject({ switchModel: true, editTechnical: false, invite: true, grantSupport: true, approveMemory: true })
    const member = canFor(principals.member(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(Object.values(member).filter(Boolean)).toHaveLength(3) // viewMembers, viewAudit, exportAudit
    const inhouse = canFor(principals.inhouse(), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(inhouse).toEqual({
      invite: true, changeRole: false, remove: true, editBrandSettings: true, editTechnical: true, switchModel: true, grantSupport: false,
      viewMembers: true, viewAudit: false, exportAudit: false, approveMemory: false,
    })
    const granted = canFor(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), DESIGN_ROWS, DESIGN_CAN_ROWS, NOW)
    expect(granted).toMatchObject({ grantSupport: false, viewAudit: true, exportAudit: true, approveMemory: true })
  })
})

/**
 * Every row against every principal, written by hand from decisions 19 and 27a (the Inhouse team holds every Admin
 * control but granting itself access; a brand's audit log needs a live grant; personal stays the owner's). Columns:
 * Member, Admin, Inhouse without a grant, Inhouse with a live grant, smoke, monitor, release. `ok` passes; `obj` passes
 * only through requireObject; `no` is a bare forbidden; `grant` is grant_required; `audit` passes with the
 * support.access duty. Rows 22 to 49 are p3-design section 3's table: a person (and smoke where listed) reaches an
 * `ownerObject` or `personal` row only through the owner check; Inhouse under a grant reads an `ownerObject` row with
 * no owner; pause and resume are Admin and Inhouse (item 19); drain and warm-up are release's only.
 */
type Want = 'ok' | 'obj' | 'no' | 'grant' | 'audit'
const ORACLE: Record<string, readonly [Want, Want, Want, Want, Want, Want, Want]> = {
  'GET /api/health': ['no', 'no', 'no', 'no', 'no', 'ok', 'no'],
  'GET /api/me': ['ok', 'ok', 'ok', 'ok', 'ok', 'no', 'no'],
  'GET /api/members': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'POST /api/members/invites': ['no', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  // Decision 19b: role changes are Admin-only (every change makes or unmakes an Admin).
  'PUT /api/members/:id/role': ['no', 'ok', 'no', 'no', 'no', 'no', 'no'],
  'DELETE /api/members/:id': ['no', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'GET /api/settings/personal': ['obj', 'obj', 'no', 'no', 'obj', 'no', 'no'],
  'PUT /api/settings/personal/:key': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'GET /api/settings/brand': ['ok', 'ok', 'ok', 'ok', 'ok', 'no', 'no'],
  'PUT /api/settings/brand/:key': ['no', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'GET /api/settings/technical': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'PUT /api/settings/technical/:key': ['no', 'obj', 'ok', 'ok', 'no', 'no', 'no'],
  'PUT /api/photo': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'DELETE /api/photo': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'GET /api/members/:id/photo': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'GET /api/grants': ['no', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'POST /api/grants': ['no', 'ok', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/grants/:id/end': ['no', 'ok', 'no', 'no', 'no', 'no', 'no'],
  'GET /api/audit': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'GET /api/audit/export.csv': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/client-error': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  // P3, rows 22 to 49 (p3-design section 3).
  'GET /api/chats': ['obj', 'obj', 'grant', 'audit', 'obj', 'no', 'no'],
  'POST /api/chats': ['obj', 'obj', 'no', 'no', 'obj', 'no', 'no'],
  'GET /api/chats/:id': ['obj', 'obj', 'grant', 'audit', 'obj', 'no', 'no'],
  'PUT /api/chats/:id/title': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'PUT /api/chats/:id/pin': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/chats/delete': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/chats/restore': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/chats/:id/turns': ['obj', 'obj', 'no', 'no', 'obj', 'no', 'no'],
  'POST /api/turns/:turnId/interrupt': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/turns/:turnId/stop': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'GET /api/runs/active': ['obj', 'obj', 'grant', 'audit', 'obj', 'no', 'no'],
  'GET /api/traces/:id': ['obj', 'obj', 'grant', 'audit', 'no', 'no', 'no'],
  'GET /api/socket': ['obj', 'obj', 'grant', 'audit', 'obj', 'no', 'no'],
  'GET /api/pause': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'POST /api/pause': ['no', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'POST /api/resume': ['no', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'GET /api/models': ['ok', 'ok', 'ok', 'ok', 'ok', 'no', 'no'],
  'POST /api/chats/:id/attachments': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'GET /api/chats/:id/files': ['obj', 'obj', 'grant', 'audit', 'no', 'no', 'no'],
  'GET /api/files/:fileId': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'GET /api/usage': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'GET /api/memory': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'PUT /api/memory/personal/:id/forgotten': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  // Item 19 (2026-11-20): the Inhouse team forgets a team fact only under a live grant, audited.
  'PUT /api/memory/brand/:id/forgotten': ['no', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/ops/drain': ['no', 'no', 'no', 'no', 'no', 'no', 'ok'],
  'GET /api/ops/drain': ['no', 'no', 'no', 'no', 'no', 'no', 'ok'],
  // Route 50, the test build's undrain (W2): release only, like drain; its handler answers 404 outside the test build.
  'DELETE /api/ops/drain': ['no', 'no', 'no', 'no', 'no', 'no', 'ok'],
  'POST /api/ops/warmup': ['no', 'no', 'no', 'no', 'no', 'no', 'ok'],
  'POST /api/chats/:id/session/reset': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  // Route 51 (W1 PR 6): revive one quarantined due task, release only.
  'POST /api/ops/tasks/revive': ['no', 'no', 'no', 'no', 'no', 'no', 'ok'],
  // Route 67 (P4 wave 4): the test build's alarm-now control, release only; its handler answers 404 outside the test build.
  'POST /api/ops/alarm': ['no', 'no', 'no', 'no', 'no', 'no', 'ok'],
  // Rows 59 to 61 (P4 W4): Activity is brand data like Memory; the bell is personal, and the Inhouse team has none.
  'GET /api/activity': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'GET /api/notifications': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/notifications/read': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  // Rows 57 and 58 (P4 W3): Today is brand data like Activity; setting an item aside is a write the Inhouse team may make under a live grant (audited).
  'GET /api/today': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'PUT /api/today/:id/aside': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  // Rows 62 to 66 (P4 W5): the Library is brand data (Inhouse under a grant may list, download, delete and restore); the
  // upload is people only.
  'GET /api/library': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/library/uploads': ['ok', 'ok', 'no', 'no', 'no', 'no', 'no'],
  'GET /api/library/:id/download': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/library/delete': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/library/restore': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  // Rows 52 to 56 (P4 W2): brand data for every person; the Inhouse team reads and writes only under a live grant.
  'GET /api/routines': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'PUT /api/routines/:id/enabled': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/routines/:id/run': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/routines/:id/delete': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/routines/:id/restore': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  // Rows 77 to 83 (P6a PR0). Team memory approval: Admins, and the Inhouse team only under a live grant (audited);
  // members never. Skills list: everyone reads, no grant needed (the text is route 84). Team requests are addressed to
  // the Inhouse team: it reads them and alone marks one done or declined, with or without a grant, and never files or
  // withdraws one; people read and file, and withdraw only their own (the owner check).
  'GET /api/memory/waiting': ['no', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'PUT /api/memory/brand/:id/approved': ['no', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'GET /api/skills': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'GET /api/team-requests': ['ok', 'ok', 'ok', 'ok', 'no', 'no', 'no'],
  'POST /api/team-requests': ['ok', 'ok', 'no', 'no', 'no', 'no', 'no'],
  'PUT /api/team-requests/:id/status': ['no', 'no', 'ok', 'ok', 'no', 'no', 'no'],
  'PUT /api/team-requests/:id/withdrawn': ['obj', 'obj', 'no', 'no', 'no', 'no', 'no'],
  // Rows 84 and 85 (P6a brand skills): a skill's text is brand data (the Inhouse team under a live grant, audited);
  // people delete a brand skill, and its maker or an admin is the store's rule. The Inhouse team deletes none.
  'GET /api/skills/:name': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  'POST /api/skills/brand/:id/delete': ['ok', 'ok', 'no', 'no', 'no', 'no', 'no'],
  'GET /api/routines/:id/runs': ['ok', 'ok', 'grant', 'audit', 'no', 'no', 'no'],
  // Rows 91 to 93 (P8a F2): Shopify's privacy webhooks. No principal passes; Shopify's HMAC is their authentication.
  'POST /api/webhooks/shopify/customers-data-request': ['no', 'no', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/webhooks/shopify/customers-redact': ['no', 'no', 'no', 'no', 'no', 'no', 'no'],
  'POST /api/webhooks/shopify/shop-redact': ['no', 'no', 'no', 'no', 'no', 'no', 'no'],
  // Row 94 (P8a F2): the runbook closes a privacy request, release only.
  'POST /api/ops/privacy-requests/:id/close': ['no', 'no', 'no', 'no', 'no', 'no', 'ok'],
}
const DECISION: Record<Want, ReturnType<typeof checkAccess>> = {
  ok: { ok: true }, obj: { ok: true, objectCheck: 'required' }, no: { refused: 'forbidden' },
  grant: { refused: 'forbidden', reason: 'grant_required' }, audit: { ok: true, audit: 'support.access' },
}
const COLUMNS: readonly [string, () => Principal][] = [
  ['member', () => principals.member()], ['admin', () => principals.admin()], ['inhouse', () => principals.inhouse()],
  ['inhouse with a grant', () => principals.inhouse({ id: 'g', endsAtMs: NOW + 1 })], ['smoke', principals.smoke], ['monitor', principals.monitor],
  ['release', principals.release],
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

// INHOUSE_BRAND_WRITES (server/testing/inhouse-brand-writes.ts): the brand_data writes the Inhouse team may make under a
// live grant (item 19). Changed for item 19: before it, no brand_data write row could list inhouse.
/** Rows outside technical, report and baseline that list Inhouse on a non-GET method: personal, or brand_data off the list. */
const inhouseWriteProblems = (rows: readonly AccessRow[]) =>
  rows.filter(x => x.method !== 'GET' && (x.class === 'personal' || (x.class === 'brand_data' && !INHOUSE_BRAND_WRITES.includes(`${x.method} ${x.pattern}`))) && x.allow.includes('inhouse')).map(x => `${x.method} ${x.pattern}`)

/**
 * The Inhouse team never grants itself access (decision 19), never changes a role (19b: every change makes or unmakes
 * an Admin), and the audit log is never baseline (BD7).
 */
const GRANT_WRITES = ['POST /api/grants', 'POST /api/grants/:id/end', 'PUT /api/members/:id/role']
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

/** The closed list of `open` rows (matrix.ts): the health check, and P3's drain and warm-up (p3-design section 3). */
const OPEN_ROWS = ['GET /api/health', 'POST /api/ops/drain', 'GET /api/ops/drain', 'DELETE /api/ops/drain', 'POST /api/ops/warmup', 'POST /api/ops/tasks/revive', 'POST /api/ops/alarm', 'POST /api/ops/privacy-requests/:id/close']
const openProblems = (rows: readonly AccessRow[]) => {
  const keys = rows.filter(x => x.class === 'open').map(x => `${x.method} ${x.pattern}`)
  return [...keys.filter(k => !OPEN_ROWS.includes(k)).map(k => `${k} is open`), ...OPEN_ROWS.filter(k => !keys.includes(k)).map(k => `${k} is not open`)]
}

/**
 * The closed list of `webhook` rows (matrix.ts, P8a F2): Shopify's three privacy webhooks, POST, no `allow`, no service,
 * each served by `webhookRoutes` (never the signed-in table).
 */
const WEBHOOK_ROWS = ['POST /api/webhooks/shopify/customers-data-request', 'POST /api/webhooks/shopify/customers-redact', 'POST /api/webhooks/shopify/shop-redact']
const webhookProblems = (rows: readonly AccessRow[]) => {
  const hooks = rows.filter(x => x.class === 'webhook')
  const keys = hooks.map(x => `${x.method} ${x.pattern}`)
  const problems = [...keys.filter(k => !WEBHOOK_ROWS.includes(k)).map(k => `${k} is webhook`)]
  if (rows.length) for (const k of WEBHOOK_ROWS) if (!keys.includes(k)) problems.push(`${k} is not webhook`)
  for (const x of hooks) {
    if (x.allow.length || (x.services ?? []).length) problems.push(`${x.method} ${x.pattern} lets a principal in`)
    if (!webhookRoutes.some(r => r.method === x.method && r.pattern === x.pattern)) problems.push(`${x.method} ${x.pattern} is not a webhook route`)
  }
  for (const r of signedInRoutes) if (keys.includes(`${r.method} ${r.pattern}`)) problems.push(`${r.method} ${r.pattern} is a webhook row on a signed-in route`)
  return problems
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
  it('webhook on a signed-in route, a webhook row that allows someone, or one of the three not webhook', () => {
    const members = rowFor(DESIGN_ROWS, 'GET', '/api/members')!
    expect(webhookProblems(DESIGN_ROWS.map(r => (r === members ? { ...r, class: 'webhook' as const } : r)))).toEqual([
      'GET /api/members is webhook', 'GET /api/members lets a principal in', 'GET /api/members is not a webhook route', 'GET /api/members is a webhook row on a signed-in route',
    ])
    const redact = rowFor(DESIGN_ROWS, 'POST', '/api/webhooks/shopify/customers-redact')!
    expect(webhookProblems(DESIGN_ROWS.map(r => (r === redact ? { ...r, allow: ['admin' as const] } : r)))).toEqual(['POST /api/webhooks/shopify/customers-redact lets a principal in'])
    expect(webhookProblems(DESIGN_ROWS.map(r => (r === redact ? { ...r, class: 'open' as const } : r)))).toEqual(['POST /api/webhooks/shopify/customers-redact is not webhook'])
    expect(webhookProblems(DESIGN_ROWS)).toEqual([])
  })
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
    expect(openProblems(DESIGN_ROWS.map(r => (r.class === 'open' ? { ...r, class: 'baseline' as const } : r)))).toEqual(['GET /api/health is not open', 'POST /api/ops/drain is not open', 'GET /api/ops/drain is not open', 'DELETE /api/ops/drain is not open', 'POST /api/ops/warmup is not open', 'POST /api/ops/tasks/revive is not open', 'POST /api/ops/alarm is not open', 'POST /api/ops/privacy-requests/:id/close is not open'])
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
    // Item 19: row 45 listing inhouse is on the closed list; the personal forget listing inhouse never is.
    const brandForget = rowFor(DESIGN_ROWS, 'PUT', '/api/memory/brand/:id/forgotten')!
    const personalForget = rowFor(DESIGN_ROWS, 'PUT', '/api/memory/personal/:id/forgotten')!
    const listed = DESIGN_ROWS.map(r => (r === brandForget || r === personalForget ? { ...r, allow: [...r.allow, 'inhouse' as const] } : r))
    expect(inhouseWriteProblems(listed)).toEqual(['PUT /api/memory/personal/:id/forgotten'])
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
    it('the open rows are exactly health, drain and warm-up (a closed list)', () => {
      expect(openProblems(rows)).toEqual([])
    })
    // Changed for item 19: the brand_data writes on INHOUSE_BRAND_WRITES (row 45) take Inhouse under a live grant, with
    // the audit duty; every other brand_data or personal write still refuses it.
    it('no row lets Inhouse write brand_data (off the closed list) or personal, and no personal row allows Inhouse', () => {
      const ih = principals.inhouse({ id: 'g', endsAtMs: Number.MAX_SAFE_INTEGER })
      for (const x of rows) {
        const listed = x.class === 'brand_data' && INHOUSE_BRAND_WRITES.includes(`${x.method} ${x.pattern}`)
        if (x.method !== 'GET' && listed) expect(checkAccess(ih, x, undefined, NOW)).toEqual({ ok: true, audit: 'support.access' })
        else if (x.method !== 'GET' && (x.class === 'brand_data' || x.class === 'personal')) expect(ok(checkAccess(ih, x, { ownerId: 'm_ih' }, NOW))).toBe(false)
        if (x.class === 'personal') expect(x.allow).not.toContain('inhouse')
      }
    })
    it('Inhouse never creates or ends a grant or changes a role, and the audit log stays brand_data', () => {
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
    it('the webhook rows are exactly Shopify\'s three privacy webhooks (a closed list), each a webhook route, and no principal passes one', () => {
      expect(webhookProblems(rows)).toEqual([])
      for (const x of rows.filter(y => y.class === 'webhook')) for (const [, p] of COLUMNS) expect(checkAccess(p(), x, undefined, NOW)).toEqual({ refused: 'forbidden' })
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
  const RELEASE_ROWS = ['POST /api/ops/drain', 'GET /api/ops/drain', 'DELETE /api/ops/drain', 'POST /api/ops/warmup', 'POST /api/ops/tasks/revive', 'POST /api/ops/alarm', 'POST /api/ops/privacy-requests/:id/close']
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

  // Changed for decision 19 (feat/inhouse-admin-controls): a baseline write listing Inhouse lets it through, with or
  // without a grant, and with no support.access duty (pause is not brand data).
  it('Inhouse on pause and resume: listed (item 19), allowed with or without a grant', () => {
    for (const rows of [DESIGN_ROWS, accessMatrix]) {
      for (const pattern of ['/api/pause', '/api/resume']) {
        const r = rowFor(rows, 'POST', pattern)!
        expect(r.allow).toEqual(['admin', 'inhouse'])
        expect(checkAccess(principals.inhouse({ id: 'g', endsAtMs: NOW + 1 }), r, undefined, NOW)).toEqual({ ok: true })
        expect(checkAccess(principals.inhouse(null), r, undefined, NOW)).toEqual({ ok: true })
        expect(checkAccess(principals.member(), r, undefined, NOW)).toEqual({ refused: 'forbidden' })
        expect(checkAccess(principals.admin(), r, undefined, NOW)).toEqual({ ok: true })
      }
    }
  })

  it('release is refused on a row that lists it but isn\'t open (the class guard, not only the services list)', () => {
    // Synthetic rows: no committed row lists release outside `open`, so only these pin the guard.
    for (const cls of ['brand_data', 'baseline', 'technical', 'personal', 'report'] as const) {
      for (const method of ['GET', 'POST'] as const) {
        const r: AccessRow = { method, pattern: '/x', class: cls, allow: ['member', 'admin'], services: ['release'] }
        expect(checkAccess(principals.release(), r, { ownerId: 'm_a' }, NOW), `${method} ${cls}`).toEqual({ refused: 'forbidden' })
      }
    }
    expect(checkAccess(principals.release(), { method: 'POST', pattern: '/x', class: 'open', allow: [], services: ['release'] }, undefined, NOW)).toEqual({ ok: true })
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

describe('every Inhouse brand_data read has a support.access line (P3 W1 PR 1: "no line, no data")', () => {
  it('the audit contract names each brand_data GET row that allows Inhouse, the design rows and the committed ones', () => {
    for (const rows of [DESIGN_ROWS, accessMatrix] as readonly (readonly AccessRow[])[]) {
      const unnamed = rows.filter(r => r.method === 'GET' && r.class === 'brand_data' && r.allow.includes('inhouse'))
        .filter(r => !AuditArgsSchema.safeParse({ action: 'support.access', grantId: 'g_1', method: 'GET', route: r.pattern }).success)
        .map(r => r.pattern)
      expect(unnamed).toEqual([])
    }
  })
})

// Review fold (Sonnet L1, #328): the oracle answers rows 79 and 80 the same whether they are technical or baseline
// (every principal gets `ok` either way), so their classes are pinned here, on both copies of the rows.
describe('P6a rows whose class the oracle cannot see', () => {
  it('row 79 is technical and row 80 is baseline', () => {
    for (const rows of [DESIGN_ROWS, accessMatrix]) {
      expect(rowFor(rows, 'GET', '/api/skills')?.class).toBe('technical')
      expect(rowFor(rows, 'GET', '/api/team-requests')?.class).toBe('baseline')
    }
  })
})
