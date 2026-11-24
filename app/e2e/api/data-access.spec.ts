// Data and access (P8a D) on the test build: the retention row's settings and Export everything (route 95).
// - Retention: everyone reads `d:chats` and `d:steps` (route 11); only the Inhouse team writes them (route 12). An Admin
//   is refused `admin_read_only` and a Member `forbidden`, and neither refusal writes a line.
// - Export everything: one NDJSON download naming every store in the registry and including the exportable P2 to P6a stores. Admins get
//   it; the Inhouse team only under a live grant (its support.access line first); Members and service tokens never. Its
//   audit line holds counts, never a store's rows.
// Stored audit arguments aren't in any API answer, so they're read from the test build's local D1 (db.ts).
import { expect, test } from '@playwright/test'
import { actor, call, endLiveGrants, expectError, me, putSetting, settingRev } from './kit.ts'
import { auditAfter, auditMax } from './db.ts'

const admin = actor('admin')
const dana = actor('memberA')
const alex = actor('inhouse')
test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ request }) => {
  await endLiveGrants(request)
  // A grant expiry not yet logged is written by the first audit read; flush it so no test sees it as a stray line.
  await call(request, admin, 'GET', '/api/audit')
})
test.afterAll(async ({ request }) => { await endLiveGrants(request) })

/** The registry's stores, by name, as the export's header lists them, and which of them it includes. */
const P2_TO_P6A = ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'chats', 'chat_messages', 'tool_calls', 'chat_files', 'files/', 'memories', 'usage_months', 'usage_turns',
  'activity_lines', 'today_items', 'today_aside', 'library_uploads', 'library_marks', 'library/', 'routines', 'routine_slots', 'team_requests', 'brand_skills', 'connector_accounts', 'notify_channels', 'notify_channel_list']

const lines = (text: string) => text.trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, any>)

test('retention: everyone reads the periods; only the Inhouse team changes them', async ({ request }) => {
  // `d:steps`, not `d:chats`: revisions-paging.spec.ts needs `d:chats` never written.
  for (const who of [admin, dana, alex]) {
    const r = await call(request, who, 'GET', '/api/settings/technical')
    expect(r.status, r.text).toBe(200)
  }
  const mark = auditMax()
  expectError(await putSetting(request, admin, 'technical', 'd:steps', '24 months'), 403, 'forbidden', 'admin_read_only')
  expectError(await putSetting(request, dana, 'technical', 'd:steps', '24 months'), 403, 'forbidden')
  expect(auditAfter(mark), 'a refused write writes nothing').toEqual([])

  const alexId = (await me(request, alex)).memberId
  const saved = await putSetting(request, alex, 'technical', 'd:steps', '24 months')
  expect(saved.status, saved.text).toBe(200)
  const written = auditAfter(mark)
  expect(written.map(l => [l.action, l.actor_id])).toEqual([['setting.changed', alexId]])
  expect(JSON.parse(written[0].args_json)).toMatchObject({ scope: 'technical', key: 'd:steps', value: '24 months' })
  const read = await call(request, admin, 'GET', '/api/settings/technical')
  expect(read.json.items.find((i: { key: string }) => i.key === 'd:steps')?.value).toBe('24 months')
  // Back to the default, so nothing else sees a changed period.
  const reset = await call(request, alex, 'PUT', '/api/settings/technical/d%3Asteps', { json: { value: null, ifRev: await settingRev(request, alex, 'technical', 'd:steps') } })
  expect(reset.status, reset.text).toBe(200)
})

test('Export everything: a Member, a service token and the Inhouse team without a grant are refused, and nothing is logged', async ({ request }) => {
  const mark = auditMax()
  expectError(await call(request, dana, 'GET', '/api/data-access/export'), 403, 'forbidden')
  expectError(await call(request, alex, 'GET', '/api/data-access/export'), 403, 'forbidden', 'grant_required')
  expectError(await call(request, actor('smoke'), 'GET', '/api/data-access/export'), 403, 'forbidden')
  expect(auditAfter(mark)).toEqual([])
})

test('Export everything: an Admin downloads one file holding every P2 to P6a store, with a counts-only line', async ({ request }) => {
  const adminId = (await me(request, admin)).memberId
  const alexId = (await me(request, alex)).memberId
  const mark = auditMax()
  const r = await call(request, admin, 'GET', '/api/data-access/export')
  expect(r.status, r.text.slice(0, 200)).toBe(200)
  expect(r.headers['content-type']).toBe('application/x-ndjson; charset=utf-8')
  expect(r.headers['content-disposition']).toMatch(/^attachment; filename="inhouse-export-\d{4}-\d{2}-\d{2}\.ndjson"$/)
  expect(r.headers['cache-control']).toContain('no-store')
  const out = lines(r.text)
  const header = out[0]
  expect(header).toMatchObject({ format: 1, kind: 'brandForCaller', memberId: adminId })
  const named = (header.stores as { name: string; export: boolean }[])
  for (const store of P2_TO_P6A) expect(named.find(s => s.name === store), store).toMatchObject({ export: true })
  const end = out.at(-1)!
  expect(end.end).toBe(true)
  for (const store of ['notify_sends', 'SignIn']) {
    expect(named.find(s => s.name === store), store).toMatchObject({ export: false })
    expect(out.some(l => l.store === store), store).toBe(false)
    expect(end.counts, store).not.toHaveProperty(store)
  }
  for (const store of P2_TO_P6A) expect(end.counts[store], store).toBe(out.filter(l => l.store === store).length)
  // The seeded team is in it, as the Members page shows them: no sign-in subject, no Inhouse team row, and no other
  // member's chat (P8a D review, option 1).
  expect(out.some(l => l.store === 'members' && l.row.id === adminId)).toBe(true)
  expect(out.filter(l => l.store === 'members').every(l => !('subject' in l.row))).toBe(true)
  expect(out.filter(l => l.store === 'members').some(l => l.row.id === alexId)).toBe(false)
  expect(out.filter(l => l.store === 'chats').every(l => l.row.owner_id === adminId)).toBe(true)

  const logged = auditAfter(mark)
  expect(logged.map(l => [l.action, l.actor_id])).toEqual([['data.exported', adminId]])
  const args = JSON.parse(logged[0].args_json)
  expect(Object.keys(args).sort()).toEqual(['items', 'scope', 'stores'])
  expect(args.scope).toBe('brand')
  expect(args.stores).toBe(named.filter(s => s.export).length)
})

test('Export everything: the Inhouse team under a live grant gets it, its support.access line first', async ({ request }) => {
  const alexId = (await me(request, alex)).memberId
  const grant = await call(request, admin, 'POST', '/api/grants', { json: { hours: 1 } })
  expect(grant.status, grant.text).toBe(201)
  const mark = auditMax()
  const r = await call(request, alex, 'GET', '/api/data-access/export')
  expect(r.status, r.text.slice(0, 200)).toBe(200)
  expect(lines(r.text).at(-1)).toMatchObject({ end: true })
  const logged = auditAfter(mark)
  expect(logged.map(l => [l.action, l.actor_id])).toEqual([['support.access', alexId], ['data.exported', alexId]])
  expect(JSON.parse(logged[0].args_json)).toMatchObject({ method: 'GET', route: '/api/data-access/export' })
})

test('Export everything\'s check (route 96): its size for an Admin, nothing written; refused like route 95', async ({ request }) => {
  const mark = auditMax()
  const r = await call(request, admin, 'GET', '/api/data-access/export/check')
  expect(r.status, r.text).toBe(200)
  const size = JSON.parse(r.text) as { stores: number; items: number }
  expect(size.stores).toBeGreaterThanOrEqual(P2_TO_P6A.length)
  expect(size.items).toBeGreaterThan(0)
  expect(auditAfter(mark)).toEqual([])
  expectError(await call(request, dana, 'GET', '/api/data-access/export/check'), 403, 'forbidden')
})
