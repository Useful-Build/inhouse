// Route 95, `GET /api/data-access/export` (P8a D, Export everything), through the real request path (api.ts, the real
// routes, matrix rows, stores, migrations and R2; sign-in stood in for). Ways it can fail, written down first:
//  1. a Member, a service token, or the Inhouse team without a live grant gets the export; Inhouse with a grant gets it
//     without its support.access line first;
//  2. the download misses a store the registry exports (P2 to P6a), or the header doesn't name every registry store;
//  3. the audit line holds content (a store's name, a row, a file name, a chat title) instead of counts, or is missing,
//     or doesn't match what the export planned;
//  4. the export is built whole before it is sent (R2 files read before the first line is pulled);
//  5. an R2 or D1 failure before the answer starts is a 200 with a cut-off file instead of a 503 (and leaves an audit
//     line for an export that never started);
//  6. a failure mid-download logs a storage message, or ends the file as if it were whole;
//  7. Data and access's next cleanup isn't the time the retention task schedules itself for;
//  8. the download holds what the matrix wouldn't show its caller: a sign-in subject, an Inhouse team email, another
//     member's personal memory or setting, or another member's chat (P8a D review, option 1);
//  9. a brand too big for one request starts a 200 that stops part way (with an audit line) instead of a plain refusal;
// 10. route 96 (the page's check) writes an audit line of its own, or answers differently from route 95.
import { env } from 'cloudflare:workers'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { accessMatrix } from '../access-matrix.ts'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { checkAccess } from '../auth/matrix.ts'
import type { Principal } from '../auth/principal.ts'
import { openStores } from '../db/stores.ts'
import type { Stores, StoresEnv } from '../db/stores.ts'
import { dataExportStore } from '../data-access/store.ts'
import { lastLineId, linesSince } from '../db/test-support.ts'
import { routes } from '../routes.ts'
import { addPerson } from '../routines/test-kit.ts'
import { tables } from '../../ops/tables/index.ts'
import { nextDaily } from '../ops/backup-handlers.ts'
import { RETENTION_AT } from '../ops/retention-handlers.ts'
import { nextCleanupMs } from '../../shared/contract/data-access.ts'

const db = env.DB
const NOW = Date.parse('2026-11-24T12:00:00Z')
const ADMIN = 'm_dx_admin'
const MEMBER = 'm_dx_member'
const IH = 'm_dx_ih'
const GRANT = 'g_dxtest'
const SECRET_TITLE = 'Refund plan for Dana'
const FILE_KEY = 'library/dx/report.csv'
const IH_EMAIL = 'ian@inhouse.example'
const MEMBER_FACT = 'Dana prefers decaf'
const MEMBER_SETTING = 'MEMBERSETTINGVALUE'
const ADMIN_CHAT = 'Admin weekly plan'

const person = (memberId: string, role: 'member' | 'admin'): Principal => ({ kind: 'person', memberId, role, subject: `s-${memberId}`, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })
const inhouse = (live: boolean): Principal => ({ kind: 'inhouse', memberId: IH, subject: 's-ih', grant: live ? { id: GRANT, endsAtMs: NOW + 60_000 } : null, requestId: `req-${Math.random()}`, expMs: NOW + 600_000 })
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

async function send(principal: Principal, files: StoresEnv['FILES'] = env.FILES, path = '/api/data-access/export', over: Partial<Stores> = {}) {
  const parts: ApiParts = { authenticate: async () => ({ principal }), checkOrigin: () => null, checkAccess, stores: e => ({ ...openStores({ ...(e as unknown as StoresEnv), FILES: files }), ...over }), routes, accessMatrix }
  return api(parts, new Request(`http://brand.localhost:8787${path}`), env, ctx, `req-${Math.random()}`)
}
const ndjson = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer()).trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, any>)

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  await addPerson(ADMIN, 'admin')
  await addPerson(MEMBER)
  await db.prepare("INSERT INTO members (id, kind, status, name, subject, email_norm, created_at_ms) VALUES (?, 'inhouse', 'active', 'Ian', 's-ih', ?, 1) ON CONFLICT DO NOTHING").bind(IH, IH_EMAIL).run()
  await db.prepare("UPDATE members SET subject = 's-' || id, email_norm = id || '@brand.example' WHERE id IN (?, ?)").bind(ADMIN, MEMBER).run()
  await db.prepare('INSERT INTO support_grants (id, created_by, created_at_ms, ends_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(GRANT, ADMIN, NOW - 1000, NOW + 60_000).run()
  await db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind('c_dx_one', MEMBER, SECRET_TITLE, NOW - 1000, NOW - 1000).run()
  await db.prepare('INSERT INTO chats (id, owner_id, title, created_at_ms, last_at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').bind('c_dx_admin', ADMIN, ADMIN_CHAT, NOW - 1000, NOW - 1000).run()
  await db.prepare("INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ('mem_dx_member', 'person', ?, ?, 'active', ?, ?, ?) ON CONFLICT DO NOTHING").bind(MEMBER, MEMBER_FACT, MEMBER, NOW, NOW).run()
  await db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (?, 'p:dx', ?, 1, ?, ?, 'req-dx') ON CONFLICT DO NOTHING").bind(MEMBER, JSON.stringify(MEMBER_SETTING), NOW, MEMBER).run()
  await env.FILES.put(FILE_KEY, 'sku,qty\nA1,3\n', { httpMetadata: { contentType: 'text/csv' } })
})
afterAll(() => {
  vi.useRealTimers()
})

describe('who gets the export (failure 1)', () => {
  it.each([
    ['a Member', person(MEMBER, 'member'), undefined],
    ['the Inhouse team without a grant', inhouse(false), 'grant_required'],
  ] as const)('%s is refused, and nothing is logged', async (_, who, reason) => {
    const since = await lastLineId(db)
    const res = await send(who)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden', ...(reason ? { reason } : {}) } })
    expect(await linesSince(db, since)).toEqual([])
  })

  it('the Inhouse team under a live grant gets it, after its support.access line', async () => {
    const since = await lastLineId(db)
    const res = await send(inhouse(true))
    expect(res.status).toBe(200)
    const lines = await ndjson(res)
    expect(lines.at(-1)).toMatchObject({ end: true })
    const logged = await linesSince(db, since)
    expect(logged.map(l => [l.action, l.actor_id])).toEqual([['support.access', IH], ['data.exported', IH]])
    expect(JSON.parse(logged[0].args_json)).toEqual({ grantId: GRANT, method: 'GET', route: '/api/data-access/export' })
  })
})

describe('an Admin downloads everything (failures 2 and 3)', () => {
  it('as one NDJSON attachment holding every exported store, with a counts-only audit line', async () => {
    const since = await lastLineId(db)
    const res = await send(person(ADMIN, 'admin'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/x-ndjson; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="inhouse-export-2026-11-24.ndjson"')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Cache-Control')).toContain('no-store')
    const lines = await ndjson(res)

    // The header names every store in the registry, included or not; the end line counts every included one.
    const header = lines[0]
    expect(header).toMatchObject({ format: 1, kind: 'brandForCaller', memberId: ADMIN, atMs: NOW })
    expect((header.stores as { name: string }[]).map(s => s.name)).toEqual(tables.map(t => t.name))
    const end = lines.at(-1)!
    expect(end.end).toBe(true)
    const exported = tables.filter(t => t.export).map(t => t.name)
    expect(Object.keys(end.counts).sort()).toEqual([...exported].sort())
    for (const name of exported) expect(end.counts[name], name).toBe(lines.filter(l => l.store === name).length)

    // The Admin's own chat and the Library file are in it; another member's chat isn't.
    expect(lines.filter(l => l.store === 'chats').map(l => l.row.title)).toEqual([ADMIN_CHAT])
    const file = lines.find(l => l.store === 'library/' && l.key === FILE_KEY)
    expect(file).toMatchObject({ contentType: 'text/csv', size: 13 })
    expect(atob(file!.base64)).toBe('sku,qty\nA1,3\n')

    // One line, by the Admin, counts only: no store name, row, file key or title.
    const logged = await linesSince(db, since)
    expect(logged.map(l => [l.action, l.actor_id, l.target_kind, l.target_id])).toEqual([['data.exported', ADMIN, null, null]])
    const args = JSON.parse(logged[0].args_json)
    // The line counts what the plan found; the export, read after it was written, also carries that line itself.
    const items = Object.values(end.counts as Record<string, number>).reduce((n, c) => n + c, 0)
    expect(args).toEqual({ scope: 'brand', stores: exported.length, items: items - 1 })
    expect(lines.filter(l => l.store === 'audit_log' && l.row.action === 'data.exported' && l.row.actor_id === ADMIN && l.row.req_id === logged[0].req_id)).toHaveLength(1)
    expect(logged[0].args_json).not.toMatch(/chats|library|Dana|report/)
  })

  it('refuses a query it does not take', async () => {
    const res = await send(person(ADMIN, 'admin'), env.FILES, '/api/data-access/export?scope=person')
    expect(res.status).toBe(400)
  })
})

describe('what the download never holds (failure 8)', () => {
  it.each([
    ['an Admin', () => person(ADMIN, 'admin')],
    ['the Inhouse team under a grant', () => inhouse(true)],
  ] as const)('%s gets no subject, no Inhouse team email, and no other member\'s memory, setting or chat', async (_, who) => {
    const res = await send(who())
    expect(res.status).toBe(200)
    const text = new TextDecoder().decode(await res.arrayBuffer())
    for (const secret of ['s-ih', `s-${ADMIN}`, `s-${MEMBER}`, IH_EMAIL, MEMBER_FACT, MEMBER_SETTING, SECRET_TITLE]) expect(text.includes(secret), secret).toBe(false)
    const lines = text.trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, any>)
    expect(lines.filter(l => l.store === 'members').every(l => l.row.id !== IH && !('subject' in l.row))).toBe(true)
    // The Members page's fields, so the Admin and the member are there with their emails as route 3 shows them.
    expect(lines.find(l => l.store === 'members' && l.row.id === MEMBER)?.row).toMatchObject({ id: MEMBER, email: `${MEMBER}@brand.example`, role: 'member' })
  })
})

describe('a brand too big for one request (failure 9)', () => {
  const tiny = (files: StoresEnv['FILES'] = env.FILES) => ({ dataExport: dataExportStore({ db, bucket: files, budget: { d1: 1, r2: 1 } }) })
  it.each(['/api/data-access/export', '/api/data-access/export/check'])('%s is a 409 too_large before the answer starts, with no audit line', async path => {
    const since = await lastLineId(db)
    const res = await send(person(ADMIN, 'admin'), env.FILES, path, tiny())
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', reason: 'too_large' } })
    expect(await linesSince(db, since)).toEqual([])
  })
})

describe('route 96, the page\'s check (failure 10)', () => {
  it('answers the size route 95 would plan, and writes nothing', async () => {
    const since = await lastLineId(db)
    const res = await send(person(ADMIN, 'admin'), env.FILES, '/api/data-access/export/check')
    expect(res.status).toBe(200)
    const size = await res.json() as { stores: number; items: number }
    expect(size.stores).toBe(tables.filter(t => t.export).length)
    expect(await linesSince(db, since)).toEqual([])
    const exported = await send(person(ADMIN, 'admin'))
    const logged = await linesSince(db, since)
    expect(JSON.parse(logged[0].args_json)).toEqual({ scope: 'brand', ...size })
    await exported.arrayBuffer()
  })

  it('refuses whom route 95 refuses; the Inhouse team under a grant gets only its support.access line', async () => {
    expect((await send(person(MEMBER, 'member'), env.FILES, '/api/data-access/export/check')).status).toBe(403)
    const none = await send(inhouse(false), env.FILES, '/api/data-access/export/check')
    expect(await none.json()).toEqual({ error: { code: 'forbidden', reason: 'grant_required' } })
    const since = await lastLineId(db)
    expect((await send(inhouse(true), env.FILES, '/api/data-access/export/check')).status).toBe(200)
    expect((await linesSince(db, since)).map(l => l.action)).toEqual(['support.access'])
  })
})

describe('streaming (failure 4)', () => {
  it('reads no file before the first line is pulled, and only as the download goes on', async () => {
    let gets = 0
    const counting = { ...env.FILES, list: env.FILES.list.bind(env.FILES), put: env.FILES.put.bind(env.FILES), delete: env.FILES.delete.bind(env.FILES), get: (async (k: string, o?: R2GetOptions) => { gets++; return env.FILES.get(k, o) }) as R2Bucket['get'] }
    const res = await send(person(ADMIN, 'admin'), counting)
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toMatch(/^\{"format":1,/)
    expect(gets).toBe(0)
    while (!(await reader.read()).done) { /* pull the rest */ }
    expect(gets).toBeGreaterThan(0)
  })
})

describe('a storage failure before the answer starts (failure 5)', () => {
  it('is a 503 with no audit line', async () => {
    const since = await lastLineId(db)
    const broken = { ...env.FILES, put: env.FILES.put.bind(env.FILES), get: env.FILES.get.bind(env.FILES), delete: env.FILES.delete.bind(env.FILES), list: async () => { throw new Error('r2 down: library/dx/report.csv') } } as unknown as StoresEnv['FILES']
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(person(ADMIN, 'admin'), broken)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: { code: 'unavailable' } })
    expect(await linesSince(db, since)).toEqual([])
    expect(JSON.stringify(errors.mock.calls)).not.toContain('report.csv')
    errors.mockRestore()
  })
})

describe('a storage failure once the download has started', () => {
  it('ends the stream with no end line, and logs only a fixed event and the error\'s name', async () => {
    const failing = { list: env.FILES.list.bind(env.FILES), put: env.FILES.put.bind(env.FILES), delete: env.FILES.delete.bind(env.FILES), get: async () => { throw new Error('r2 down: library/dx/report.csv') } } as unknown as StoresEnv['FILES']
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await send(person(ADMIN, 'admin'), failing)
    expect(res.status).toBe(200)
    await expect(res.text()).rejects.toThrow()
    expect(errors.mock.calls.map(c => c[0])).toContainEqual(expect.objectContaining({ event: 'data_export_failed', error: 'StoreUnavailableError:R2' }))
    expect(JSON.stringify(errors.mock.calls)).not.toContain('report.csv')
    errors.mockRestore()
  })
})

describe('the next cleanup (failure 7)', () => {
  test.prop([fc.integer({ min: 0, max: 4e12 })])('is the retention task\'s own next run: after now, within a day, at 03:30 UTC', nowMs => {
    const at = nextCleanupMs(nowMs)
    expect(at).toBe(nextDaily(nowMs, RETENTION_AT))
    expect(at).toBeGreaterThan(nowMs)
    expect(at - nowMs).toBeLessThanOrEqual(86_400_000)
    const d = new Date(at)
    expect([d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()]).toEqual([3, 30, 0, 0])
  })
})
