// Routes 19 and 20 on the real migrations. Ways they can fail, written down first:
//  1. paging skips or repeats a line, or isn't newest first;
//  2. `who` shows a stale name, or a pseudonymised member's old name (it must read "Former member");
//  3. the CSV's rows don't match the lines the page shows (text, order, count), or it misses its header or headers;
//  4. a grant that ran out shows no expiry line to a reader (the read must log it first);
//  5. a bad cursor or an extra query parameter reaches the store.
import { fc, test } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditPageSchema } from '../../shared/contract/audit.ts'
import type { AuditLine } from '../../shared/contract/audit.ts'
import { openStores } from '../db/stores.ts'
import { at, ctx, lastLineId, person, personPrincipal, reset } from '../db/test-support.ts'
import { exportAudit, readAudit } from './audit.ts'

const db = env.DB
const stores = openStores(env)
let u = 0
let admin: string

beforeEach(async () => {
  await reset(db)
  admin = await person(stores, { email: `a-${++u}@example.test`, subject: `sa-${u}`, role: 'admin', name: 'Ann Example' })
})

const read = async (path: string, nowMs?: number) => {
  const res = await readAudit(ctx(stores, personPrincipal(admin, 'member'), { path, nowMs }).c)
  return { status: res.status, body: (await res.json()) as unknown }
}
async function allLines(limit: number): Promise<AuditLine[]> {
  const out: AuditLine[] = []
  let cursor: string | null = null
  for (let i = 0; i < 10_000; i++) {
    const page = AuditPageSchema.parse((await read(`/api/audit?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`)).body)
    expect(page.items.length).toBeLessThanOrEqual(limit)
    out.push(...page.items)
    cursor = page.nextCursor
    if (!cursor) return out
  }
  throw new Error('no last page')
}

describe('paging (failure 1)', () => {
  test.prop([fc.integer({ min: 0, max: 30 }), fc.integer({ min: 1, max: 7 })], { numRuns: 12 })('every line once, newest first', async (extra, limit) => {
    for (let i = 0; i < extra; i++) await stores.settings.write({ owner: 'brand', scope: 'brand', key: 'm:ask', value: i % 2 === 0, ifRev: i }, at(admin))
    const ids = (await db.prepare('SELECT id FROM audit_log ORDER BY id DESC').all<{ id: number }>()).results.map(r => r.id)
    expect((await allLines(limit)).map(l => l.id)).toEqual(ids)
  })
})

describe('who (failure 2)', () => {
  it("shows the actor's current name, and Former member once pseudonymised", async () => {
    const other = await person(stores, { email: `b-${u}@example.test`, subject: `sb-${u}`, role: 'member', name: 'Bo Example' })
    await stores.settings.write({ owner: other, scope: 'personal', key: 'g:theme', value: 'Dark', ifRev: 0 }, at(other))
    let lines = await allLines(100)
    expect(lines.find(l => l.actorId === other && l.what === 'changed a setting')).toMatchObject({ who: 'Bo Example', detail: 'Theme: Dark' })
    expect(lines.find(l => l.what === 'invited a member' && l.detail.startsWith('Bo'))).toMatchObject({ who: 'Inhouse system', detail: 'Bo Example as Member' })
    await stores.members.pseudonymise(other, at(admin))
    await stores.settings.write({ owner: 'brand', scope: 'brand', key: 's:alert', value: '80%', ifRev: 0 }, at(admin))
    lines = await allLines(100)
    expect(lines.find(l => l.actorId === admin && l.what === 'changed a setting')?.who).toBe('Ann Example')
    expect(lines.filter(l => l.actorId === other).every(l => l.who === 'Former member')).toBe(true)
    expect(lines.find(l => l.what === 'invited a member' && l.actorId === 'm_system' && l.detail.endsWith('as Member'))?.detail).toBe('Former member as Member')
    expect(JSON.stringify(lines)).not.toContain('Bo Example')
  })
})

describe('the export (failure 3)', () => {
  it('is the same lines as the pages, as CSV with its header and headers', async () => {
    for (let i = 0; i < 450; i++) await db.prepare("INSERT INTO audit_log (at_ms, actor_id, action, args_json, req_id) VALUES (?, ?, 'member.removed', ?, 'r')").bind(1_800_000_000_000 + i, admin, JSON.stringify({ memberId: admin })).run()
    const lines = await allLines(100)
    const res = await exportAudit(ctx(stores, personPrincipal(admin, 'member'), { path: '/api/audit/export.csv' }).c)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="inhouse-audit-log.csv"')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    const text = await res.text()
    const rows = text.split('\r\n').filter(Boolean)
    expect(rows[0]).toBe('"When","Who","What","Detail"')
    expect(rows.slice(1)).toEqual(lines.map(l => [l.at.iso, l.who, l.what, l.detail].map(c => `"${c.replaceAll('"', '""')}"`).join(',')))
  })
})

describe('lazy expiry (failure 4) and input (failure 5)', () => {
  it('a read logs a grant that ran out before answering', async () => {
    const created = await stores.grants.create(1, at(admin, 1_800_000_000_000))
    if (!('ok' in created)) throw new Error('grant')
    const page = AuditPageSchema.parse((await read('/api/audit?limit=1', 1_800_000_000_000 + 2 * 3_600_000)).body)
    expect(page.items[0]).toMatchObject({ actorId: 'm_system', who: 'Inhouse system', what: 'Inhouse team access ended', at: { ms: created.ok.endsAt.ms } })
  })
  it('refuses a bad cursor, a bad limit and an unknown parameter with 400', async () => {
    const before = await lastLineId(db)
    for (const q of ['cursor=***', 'cursor=YWJj', 'cursor=MA', 'limit=0', 'x=1']) expect((await read(`/api/audit?${q}`)).status, q).toBe(400)
    expect(await lastLineId(db)).toBe(before)
  })
})

describe('fix round 1', () => {
  const insertLine = (action: string, args: object, actor = admin) =>
    db.prepare("INSERT INTO audit_log (at_ms, actor_id, action, args_json, req_id) VALUES (?, ?, ?, ?, 'r')").bind(1_800_000_000_000, actor, action, JSON.stringify(args)).run()
  const csvOf = async () => (await exportAudit(ctx(stores, personPrincipal(admin, 'member'), { path: '/api/audit/export.csv' }).c)).text()

  it('reads and exports an old setting line whose key left the registry or is no longer audit-safe, showing no value', async () => {
    await insertLine('setting.changed', { scope: 'brand', key: 'x:retired', value: 'Old Secret' })
    await insertLine('setting.changed', { scope: 'personal', key: 'n:channel', value: 'Another Secret' })
    const lines = await allLines(100)
    expect(lines.slice(0, 2).map(l => l.detail)).toEqual(['Send alerts to: changed (not shown)', 'x:retired: changed (not shown)'])
    const csv = await csvOf()
    expect(csv).toContain('x:retired: changed (not shown)')
    expect(csv + JSON.stringify(lines)).not.toMatch(/Secret/)
  })

  it('page 2 continues exactly after page 1 when lines are written in between (no repeat, no gap)', async () => {
    for (let i = 0; i < 6; i++) await insertLine('member.removed', { memberId: admin })
    const old = (await db.prepare('SELECT id FROM audit_log ORDER BY id DESC').all<{ id: number }>()).results.map(r => r.id)
    const p1 = AuditPageSchema.parse((await read('/api/audit?limit=3')).body)
    for (let i = 0; i < 4; i++) await insertLine('member.removed', { memberId: admin })
    const rest: number[] = []
    let cursor = p1.nextCursor
    while (cursor) {
      const p = AuditPageSchema.parse((await read(`/api/audit?limit=3&cursor=${cursor}`)).body)
      rest.push(...p.items.map(l => l.id))
      cursor = p.nextCursor
    }
    expect([...p1.items.map(l => l.id), ...rest]).toEqual(old)
  })

  it('the export defuses names that start like a formula (the route goes through csvCell)', async () => {
    const formula = await person(stores, { email: `f-${u}@example.test`, subject: `sf-${u}`, role: 'member', name: '=HYPERLINK("x")' })
    const at2 = await person(stores, { email: `g-${u}@example.test`, subject: `sg-${u}`, role: 'member', name: '@SUM(A1)' })
    await stores.settings.write({ owner: formula, scope: 'personal', key: 'g:theme', value: 'Dark', ifRev: 0 }, at(formula))
    await stores.settings.write({ owner: at2, scope: 'personal', key: 'g:theme', value: 'Light', ifRev: 0 }, at(at2))
    const rows = (await csvOf()).split('\r\n')
    expect(rows.some(r => r.includes(`,"'=HYPERLINK(""x"")","changed a setting","Theme: Dark"`))).toBe(true)
    expect(rows.some(r => r.includes(`,"'@SUM(A1)","changed a setting","Theme: Light"`))).toBe(true)
    expect(rows.some(r => /,"=|,"@/.test(r))).toBe(false)
  })
})
