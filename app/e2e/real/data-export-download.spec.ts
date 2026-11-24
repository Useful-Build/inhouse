// Settings > Data and access > Export on the test build (P8a D, routes 96 and 95), clicked as an Admin in a real browser. The page
// asks route 96 whether the export would start, then navigates to route 95, which streams one NDJSON file with its own
// Content-Disposition. e2e/api/data-access.spec.ts proves the file at the API; this proves the button: that the click reaches a
// browser download (the CSP guard is on), that the file is the product's (not the demo's invented sample), and that the person is told.
// Ways it can fail, written first:
//  1. the click starts no download (the check refused, or the navigation was blocked), or downloads the demo's sample;
//  2. the file isn't the caller's export (no header naming the store list, no end line with counts, or a member's sign-in subject in it);
//  3. the toast says the sample was downloaded, or none says the export is on its way;
//  4. the audit log gets no "downloaded all brand data" line for it.
// No timers: the wait is on the browser's own download event.
import { readFileSync } from 'node:fs'
import type { APIRequestContext } from '@playwright/test'
import { actor, call, me } from '../api/kit.ts'
import { open, signInAs } from '../support/clients/real.js'
import { expect, test } from '../support/test-build/index.js'

const admin = actor('admin')

const lastAuditId = async (request: APIRequestContext): Promise<number> => {
  const r = await call(request, admin, 'GET', '/api/audit?limit=1')
  expect(r.status, r.text).toBe(200)
  return (r.json.items as { id: number }[])[0]?.id ?? 0
}

test('Export downloads the brand\'s own export as one NDJSON file, says it is on its way, and the audit log records it', async ({ page, context, request }) => {
  const adminId = (await me(request, admin)).memberId as string
  const mark = await lastAuditId(request)
  await signInAs(context, 'admin')
  await open(page, 'admin', '#/settings/team-data')
  await expect(page.getByRole('heading', { level: 1, name: 'Data and access' })).toBeVisible()

  const download = page.waitForEvent('download')
  await page.getByRole('main').getByRole('button', { name: 'Export', exact: true }).click()
  const file = await download
  // The toast lives 6 s from the click, so it is looked at first, before the file is waited for and parsed.
  await expect(page.locator('[data-toast]').filter({ hasText: 'Your export is downloading. Big brands can take a few minutes.' })).toBeVisible()
  await expect(page.locator('[data-toast]').filter({ hasText: 'Sample export downloaded' })).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1, name: 'Data and access' })).toBeVisible()
  expect(file.suggestedFilename()).toMatch(/^inhouse-export-\d{4}-\d{2}-\d{2}\.ndjson$/)
  expect(await file.failure(), 'the download finished').toBeNull()

  const lines = readFileSync(await file.path(), 'utf8').trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, any>)
  const header = lines[0]!
  expect(header).toMatchObject({ format: 1, kind: 'brandForCaller', memberId: adminId })
  expect(header, 'the product\'s export, never the demo\'s invented sample').not.toHaveProperty('sample')
  const stores = header.stores as { name: string; export: boolean }[]
  const end = lines.at(-1)!
  expect(end.end).toBe(true)
  for (const name of ['members', 'settings', 'chats', 'activity_lines', 'team_requests', 'audit_log']) {
    expect(stores.find(s => s.name === name), `${name} is named in the header`).toMatchObject({ export: true })
    expect(end.counts[name], `${name}'s count in the end line`).toBe(lines.filter(l => l.store === name).length)
  }
  // The seeded team is in it as the Members page shows them: no sign-in subject.
  expect(lines.some(l => l.store === 'members' && l.row.id === adminId)).toBe(true)
  expect(lines.filter(l => l.store === 'members').every(l => !('subject' in l.row))).toBe(true)

  // One audit line for it, counts only (the file has been received in full, so the line was written).
  await expect.poll(async () => {
    const r = await call(request, admin, 'GET', '/api/audit?limit=20')
    expect(r.status, r.text).toBe(200)
    return (r.json.items as { id: number; what: string }[]).filter(l => l.id > mark && l.what === 'downloaded all brand data').length
  }).toBe(1)
})
