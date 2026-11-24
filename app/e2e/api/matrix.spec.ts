// The access matrix, from outside: every row against every principal (Admin, Member A, Member B, Inhouse without a
// grant, Inhouse with a live grant, `smoke`, `monitor`, and P3's `release`). The expectation is worked out here from the design's classes
// (p2-design section 3), not by the Worker's own `checkAccess`, so the two can disagree and fail. The requests change
// nothing (cases.ts): a caller the matrix lets through gets the handler's expected status, a refused one 403 before it.
// Rows come from access-matrix.ts, so a new row is swept as soon as it has a case, and routes.spec.ts fails until it has.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { auditText } from '../../shared/audit-text.ts'
import { caseFor } from './cases.ts'
import { actor, appOrigin, call, endLiveGrants, expectError, matrixRows, me, rowKey, someKey } from './kit.ts'
import type { CallOptions, Row, Who } from './kit.ts'
import { auditMax, auditAfter } from './db.ts'
import { AuditArgsSchema } from '../../shared/contract/audit.ts'

// The matrix POSTs /api/pause (route 36): resume after this file so the test build's agent isn't left paused for later
// specs (#153 round 1, L7; approved exception to the orchestrator-owned specs, this hook only).
test.afterAll(async ({ request }) => { await call(request, actor('admin'), 'POST', '/api/resume', { json: {} }) })

type Principal = Who | 'inhouseGrant'
const PRINCIPALS: Principal[] = ['admin', 'memberA', 'memberB', 'inhouse', 'inhouseGrant', 'smoke', 'monitor', 'release']
const rows = matrixRows()

type Verdict = { allowed: true } | { allowed: false; reason?: string }

/** The design's rule for one route and one principal, from the case's `design` (cases.ts), never from the server's row. */
function verdict(row: Row, who: Principal): Verdict {
  const design = caseFor(row).design
  const read = row.method === 'GET'
  if (who === 'smoke' || who === 'monitor' || who === 'release') {
    // A service token reaches only the rows that name it: monitor and release `open` rows, smoke its own chat rows (P3).
    return { allowed: design.services.includes(who) }
  }
  if (design.class === 'open') return { allowed: false }
  if (who === 'inhouse' || who === 'inhouseGrant') {
    if (!design.allow.includes('inhouse')) return { allowed: false }
    switch (design.class) {
      // Changed for item 19 (2026-11-20): a brand_data row that lists inhouse takes it for reads and writes alike, only
      // under a live grant (`allow` above already refused every row that doesn't list it).
      case 'brand_data':
        return who === 'inhouseGrant' ? { allowed: true } : { allowed: false, reason: 'grant_required' }
      // Decision 19: the Inhouse team holds every Admin control, so a baseline row it is listed on lets it read and write.
      case 'baseline': return { allowed: true }
      case 'technical': return { allowed: true }
      case 'report': return { allowed: true }
      default: return { allowed: false } // personal: never Inhouse
    }
  }
  // A person: the design's allow list names the role. Admin's technical write goes on to the object rule (adminWrite).
  const role = who === 'admin' ? 'admin' : 'member'
  // P5 W1 (route 68, the first technical write that doesn't list admin): an Admin's technical write is refused as
  // read-only, whether or not the row lists admin (p2-design section 3: Member and Admin GET technical rows only).
  if (design.class === 'technical' && !read && role === 'admin' && !design.allow.includes('admin')) return { allowed: false, reason: 'admin_read_only' }
  if (!design.allow.includes(role)) return { allowed: false }
  if (design.class === 'technical' && !read && role === 'admin' && !design.adminWrite) return { allowed: false }
  if (design.class === 'technical' && !read && role === 'member') return { allowed: false }
  return { allowed: true }
}

async function sweep(request: APIRequestContext, row: Row, who: Principal): Promise<void> {
  const c = caseFor(row)
  const options: CallOptions = {
    ...(c.json !== undefined ? { json: c.json } : {}),
    ...(c.bytes ? { bytes: c.bytes.content, contentType: c.bytes.contentType } : {}),
  }
  const r = await call(request, actor(who === 'inhouseGrant' ? 'inhouse' : who), row.method, c.path, options)
  const v = verdict(row, who)
  if (v.allowed) expect([c.passes, ...(c.alsoPasses ?? [])], `${who} ${rowKey(row)}: ${r.status} ${r.text}`).toContain(r.status)
  else expectError(r, 403, 'forbidden', v.reason)
}

/** The GET rows of these design classes (cases.ts) the Inhouse team may call, by the design's own table. */
const designGets = (...classes: string[]) => rows.filter(r => r.method === 'GET' && classes.includes(caseFor(r).design.class) && caseFor(r).design.allow.includes('inhouse'))

test.describe.configure({ mode: 'serial' })

// The sweep's POST /api/ops/drain really drains the test build's brand: undrain it after this file (the test build's
// DELETE /api/ops/drain, release only), so later specs and the next run see an undrained pool.
test.afterAll(async ({ request }) => {
  const r = await call(request, actor('release'), 'DELETE', '/api/ops/drain')
  expect(r.status, r.text).toBe(200)
})

test.describe('without a live grant', () => {
  test.beforeAll(async ({ request }) => { await endLiveGrants(request) })
  for (const row of rows) {
    for (const who of PRINCIPALS.filter(p => p !== 'inhouseGrant')) {
      test(`${rowKey(row)} as ${who}`, async ({ request }) => { await sweep(request, row, who) })
    }
  }
})

test.describe('with a live grant', () => {
  test.beforeAll(async ({ request }) => {
    await endLiveGrants(request)
    const made = await call(request, actor('admin'), 'POST', '/api/grants', { json: { hours: 1 } })
    expect(made.status, made.text).toBe(201)
  })
  test.afterAll(async ({ request }) => { await endLiveGrants(request) })
  for (const row of rows) {
    test(`${rowKey(row)} as inhouseGrant`, async ({ request }) => { await sweep(request, row, 'inhouseGrant') })
  }
})

test.describe('what the rows alone do not say', () => {
  test('two Members with the same role are strangers to each other\'s personal settings', async ({ request }) => {
    const a = actor('memberA')
    const b = actor('memberB')
    const aMe = await me(request, a)
    const bMe = await me(request, b)
    expect(aMe.role).toBe('member')
    expect(bMe.role).toBe('member')
    expect(aMe.memberId).not.toBe(bMe.memberId)
    const read = async (who: typeof a) => {
      const r = await call(request, who, 'GET', '/api/settings/personal')
      expect(r.status, r.text).toBe(200)
      return Object.fromEntries(r.json.items.map((i: { key: string; value: unknown; rev: number }) => [i.key, i])) as Record<string, { value: unknown; rev: number }>
    }
    const before = await read(a)
    // B writes a personal key: A's copy of it doesn't move. B's own list shows B's value, A's shows A's.
    const bBefore = await read(b)
    const key = someKey('personal', 'redacted')
    const set = await call(request, b, 'PUT', `/api/settings/personal/${encodeURIComponent(key)}`, { json: { value: 'Only for B', ifRev: bBefore[key]?.rev ?? 0 } })
    expect(set.status, set.text).toBe(200)
    const after = await read(a)
    expect(after[key]?.value ?? null, 'B\'s write must not show in A\'s settings').toBe(before[key]?.value ?? null)
    expect((await read(b))[key].value).toBe('Only for B')
    // There is no path that names another member's personal settings: a member id in the key is not a key.
    const aimed = await call(request, b, 'PUT', `/api/settings/personal/${aMe.memberId}`, { json: { value: 'x', ifRev: 0 } })
    expect(aimed.status).toBe(404)
  })

  // `stage` and `tm:fable:on` are literals on purpose: the spec is about them (a technical key, and the one an Admin may switch).
  test('an Admin can\'t write a technical key, except switching a model off and back on', async ({ request }) => {
    const admin = actor('admin')
    const tech = async () => Object.fromEntries((await call(request, admin, 'GET', '/api/settings/technical')).json.items.map((i: { key: string; value: unknown; rev: number }) => [i.key, i])) as Record<string, { value: unknown; rev: number }>
    const before = await tech()
    const stage = await call(request, admin, 'PUT', '/api/settings/technical/stage', { json: { value: 'Act', ifRev: before.stage?.rev ?? 0 } })
    expectError(stage, 403, 'forbidden', 'admin_read_only')
    // Clearing the key is neither 'on' nor 'off': refused.
    const cleared = await call(request, admin, 'PUT', '/api/settings/technical/tm:fable:on', { json: { value: null, ifRev: before['tm:fable:on']?.rev ?? 0 } })
    expectError(cleared, 403, 'forbidden', 'admin_read_only')
    expect((await tech()).stage?.value, 'a refused write changes nothing').toBe(before.stage?.value)
    const off = await call(request, admin, 'PUT', '/api/settings/technical/tm:fable:on', { json: { value: 'off', ifRev: before['tm:fable:on']?.rev ?? 0 } })
    expect(off.status, off.text).toBe(200)
    expect(off.json.value).toBe('off')
    // The Admin switches it back on (decision 27a).
    const back = await call(request, admin, 'PUT', '/api/settings/technical/tm:fable:on', { json: { value: 'on', ifRev: off.json.rev } })
    expect(back.status, back.text).toBe(200)
    expect(back.json.value).toBe('on')
    // A member can't write a technical key at all, not even switching off.
    expectError(await call(request, actor('memberA'), 'PUT', '/api/settings/technical/tm:fable:on', { json: { value: 'off', ifRev: back.json.rev } }), 403, 'forbidden')
  })

  test('without a grant the Inhouse team reads baseline routes and technical settings, and no brand data', async ({ request }) => {
    await endLiveGrants(request)
    const alex = actor('inhouse')
    for (const row of designGets('baseline', 'technical')) {
      expect((await call(request, alex, 'GET', caseFor(row).path)).status, row.pattern).toBe(caseFor(row).passes)
    }
    for (const row of designGets('brand_data')) expectError(await call(request, alex, 'GET', caseFor(row).path), 403, 'forbidden', 'grant_required')
    expect((await me(request, alex)).grant).toBeNull()
  })

  test('with a live grant the Inhouse team reads brand data, and each request adds one support.access line', async ({ request }) => {
    await endLiveGrants(request)
    const made = await call(request, actor('admin'), 'POST', '/api/grants', { json: { hours: 1 } })
    expect(made.status, made.text).toBe(201)
    const alex = actor('inhouse')
    try {
      const mark = auditMax()
      // Every brand_data GET route can be named by a support.access line (the audit contract's closed list; P3's chat
      // reads joined it in W1's first PR), so no Inhouse read is refused 503 for want of a line ("no line, no data",
      // p3-design section 3). A P3 stub still answers its own 503 `not_built` after the line is written.
      const logged = (route: string) => AuditArgsSchema.safeParse({ action: 'support.access', grantId: made.json.id, method: 'GET', route }).success
      expect(designGets('brand_data').filter(r => !logged(r.pattern)).map(r => r.pattern), 'a brand_data read no line can name').toEqual([])
      const reads = designGets('brand_data')
      for (const row of reads) {
        const r = await call(request, alex, 'GET', caseFor(row).path)
        expect(r.status, `${row.pattern}: ${r.text}`).toBe(caseFor(row).passes)
      }
      const lines = auditAfter(mark).filter(l => l.action === 'support.access')
      expect(lines.map(l => JSON.parse(l.args_json).route)).toEqual(reads.map(r => r.pattern))
      for (const l of lines) expect(JSON.parse(l.args_json)).toMatchObject({ method: 'GET', grantId: made.json.id })
      // The route pattern only: never an id.
      expect(lines.map(l => l.args_json).join('')).not.toContain('m_e2e_nobody')
      // Baseline and technical reads add no support.access line.
      const quiet = auditMax()
      for (const row of designGets('baseline', 'technical')) await call(request, alex, 'GET', caseFor(row).path)
      expect(auditAfter(quiet).filter(l => l.action === 'support.access')).toEqual([])
      expect((await me(request, alex)).grant?.id).toBe(made.json.id)
    } finally {
      await endLiveGrants(request)
    }
    // The page's wording for the line is the shared one.
    const text = auditText({ action: 'support.access', grantId: made.json.id, method: 'GET', route: '/api/members' }, () => null)
    expect(text.what).toBe('looked at brand data')
  })

  test('`monitor` reaches only health, and health refuses everyone else', async ({ request }) => {
    const monitor = actor('monitor')
    const health = await call(request, monitor, 'GET', '/api/health')
    expect(health.status, health.text).toBe(200)
    expect(health.json.ok).toBe(true)
    expect(health.json.signals.map((s: { name: string }) => s.name)).toEqual(expect.arrayContaining(['d1', 'migrations']))
    for (const who of ['admin', 'memberA', 'memberB', 'inhouse', 'smoke', 'release'] as const) {
      expectError(await call(request, actor(who), 'GET', '/api/health'), 403, 'forbidden')
    }
    for (const row of rows.filter(r => r.pattern !== '/api/health')) {
      const c = caseFor(row)
      const r = await call(request, monitor, row.method, c.path, { origin: appOrigin('brand'), ...(c.json !== undefined ? { json: c.json } : {}) })
      expect(r.status, `monitor ${rowKey(row)}`).toBe(403)
    }
  })
})
