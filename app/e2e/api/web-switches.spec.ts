// M1-F (N7 and Wasim's added scope, 2026-11-26) on the test build: the brand's web switches and the two spend fields.
// It would fail if a Member could flip a web switch or change a spend field, an Admin couldn't, an Admin could list a
// WebFetch host (only the Inhouse team widens what the agent may read), the job budget took a value over the $100
// ceiling or under the $0.25 start hold, or a web search value stored while it was a technical setting were lost or
// read differently once it became a brand setting. Each test puts back what it changed.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, expectError, putSetting, settingRev } from './kit.ts'
import { readSql, writeSql } from './db.ts'

const admin = actor('admin')
const dana = actor('memberA')
const inhouse = actor('inhouse')

/** A brand setting as an Admin reads it (route 9), or undefined when it was never set. */
const brandValue = async (request: APIRequestContext, key: string): Promise<{ value: unknown; rev: number } | undefined> =>
  (await call(request, admin, 'GET', '/api/settings/brand')).json.items.find((i: { key: string }) => i.key === key)

test('an Admin flips web search and reading web pages; a Member gets 403 and changes nothing', async ({ request }) => {
  try {
    for (const key of ['t:websearch', 't:webfetch_on']) {
      for (const value of [true, false, true]) {
        const r = await putSetting(request, admin, 'brand', key, value)
        expect(r.status, r.text).toBe(200)
        expect(r.json).toMatchObject({ key, value })
      }
      const before = await brandValue(request, key)
      expectError(await call(request, dana, 'PUT', `/api/settings/brand/${encodeURIComponent(key)}`, { json: { value: false, ifRev: before!.rev } }), 403, 'forbidden')
      expect(await brandValue(request, key)).toEqual(before)
      // Neither is a technical setting any more: route 12 doesn't take them, from anyone.
      expectError(await call(request, inhouse, 'PUT', `/api/settings/technical/${encodeURIComponent(key)}`, { json: { value: true, ifRev: 0 } }), 404, 'not_found', 'wrong_scope')
      // The Inhouse team flips them too (it can do what an Admin can).
      expect((await putSetting(request, inhouse, 'brand', key, false)).status).toBe(200)
    }
  } finally {
    for (const key of ['t:websearch', 't:webfetch_on']) expect((await putSetting(request, admin, 'brand', key, null)).status).toBe(200)
  }
})

test('an Admin can switch reading off and on but never list a WebFetch host; the Inhouse team can', async ({ request }) => {
  const rev = await settingRev(request, admin, 'technical', 't:webfetch')
  expectError(await call(request, admin, 'PUT', '/api/settings/technical/t%3Awebfetch', { json: { value: 'evil.example.com', ifRev: rev } }), 403, 'forbidden', 'admin_read_only')
  expectError(await call(request, admin, 'PUT', '/api/settings/brand/t%3Awebfetch', { json: { value: 'evil.example.com', ifRev: rev } }), 404, 'not_found', 'wrong_scope')
  expect(await settingRev(request, admin, 'technical', 't:webfetch')).toBe(rev)
})

test('a web search value stored while it was a technical setting survives the move: same value and rev, now a brand setting an Admin writes', async ({ request }) => {
  // As the Inhouse team's technical write stored it before M1-F (rows are keyed by owner and key, never by scope).
  const prior = readSql<{ value_json: string; rev: number }>("SELECT value_json, rev FROM settings WHERE owner = 'brand' AND key = 't:websearch'")
  writeSql("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:websearch', 'true', 7, 1, 'm_inhouse_before', 'r-before') ON CONFLICT (owner, key) DO UPDATE SET value_json = 'true', rev = 7")
  try {
    expect(await brandValue(request, 't:websearch')).toMatchObject({ key: 't:websearch', value: true, rev: 7 })
    const tech = (await call(request, admin, 'GET', '/api/settings/technical')).json.items.map((i: { key: string }) => i.key)
    expect(tech).not.toContain('t:websearch')
    const r = await call(request, admin, 'PUT', '/api/settings/brand/t%3Awebsearch', { json: { value: false, ifRev: 7 } })
    expect(r.status, r.text).toBe(200)
    expect(r.json).toMatchObject({ value: false, rev: 8 })
  } finally {
    if (prior.length === 0) expect((await putSetting(request, admin, 'brand', 't:websearch', null)).status).toBe(200)
    else writeSql("UPDATE settings SET value_json = ?, rev = rev + 1 WHERE owner = 'brand' AND key = 't:websearch'", prior[0].value_json)
  }
})

test('the monthly cap and the job budget: an Admin sets both, the job budget stays between $0.25 and $100, a Member gets 403', async ({ request }) => {
  const cap = await brandValue(request, 's:cap')
  try {
    for (const [value, status] of [['$100', 200], ['$0.25', 200], ['$40.50', 200], ['$100.01', 400], ['$101', 400], ['$0.24', 400], ['$0', 400], ['100', 400]] as const) {
      const r = await putSetting(request, admin, 'brand', 's:job_cap', value)
      expect(r.status, `${value} ${r.text}`).toBe(status)
      if (status === 400) expect(r.json).toEqual({ error: { code: 'invalid' } })
    }
    expect(await brandValue(request, 's:job_cap')).toMatchObject({ value: '$40.50' })
    expect((await putSetting(request, admin, 'brand', 's:cap', '$450')).status).toBe(200)
    expect(await brandValue(request, 's:cap')).toMatchObject({ value: '$450' })
    for (const [key, value] of [['s:job_cap', '$90'], ['s:cap', '$999']] as const) {
      const before = await brandValue(request, key)
      expectError(await call(request, dana, 'PUT', `/api/settings/brand/${encodeURIComponent(key)}`, { json: { value, ifRev: before!.rev } }), 403, 'forbidden')
      expect(await brandValue(request, key)).toEqual(before)
    }
  } finally {
    expect((await putSetting(request, admin, 'brand', 's:job_cap', null)).status).toBe(200)
    expect((await putSetting(request, admin, 'brand', 's:cap', cap?.value ?? null)).status).toBe(200)
  }
})
