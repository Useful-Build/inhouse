// Skills (P6a acceptance 7, route 79). `GET /api/skills` lists exactly the four skills the agent has, for each role. The
// oracle is the plan's text, written out here: `dataviz` plus our `pdf`, `word` and `spreadsheet`, each `need` 0 (no stage
// tag at Watch), made by the Inhouse team; never read from server/skills/list.ts. No D1 is touched, so it runs on a
// deployed test build too.
import { expect, test } from '@playwright/test'
import { actor, call, expectError } from './kit.ts'
import type { Who } from './kit.ts'

const FOUR = ['dataviz', 'pdf', 'spreadsheet', 'word']

for (const who of ['admin', 'memberA', 'memberB', 'inhouse'] as Who[]) {
  test(`${who} gets exactly the four skills, none with a stage`, async ({ request }) => {
    const r = await call(request, actor(who), 'GET', '/api/skills')
    expect(r.status, r.text).toBe(200)
    const skills = r.json as { n: string; d: string; icon: string; need: number; by: string; used: string }[]
    expect(skills.map(s => s.n).sort()).toEqual(FOUR)
    for (const s of skills) {
      expect(s.need, `${s.n} shows no stage tag at Watch`).toBe(0)
      expect(s.by).toBe('Inhouse team')
      expect(s.d.length, `${s.n} has a description`).toBeGreaterThan(0)
      expect(s.icon.length, `${s.n} has an icon`).toBeGreaterThan(0)
    }
    // Our skills carry no `mine` flag: the page's "mine" is for a brand's own, which P6a doesn't have.
    expect(skills.filter(s => (s as { mine?: boolean }).mine === true)).toEqual([])
  })
}

test('the list takes no query, and no token is a 401', async ({ request }) => {
  expectError(await call(request, actor('admin'), 'GET', '/api/skills?x=1'), 400, 'invalid')
  expectError(await call(request, actor('admin'), 'GET', '/api/skills', { token: null }), 401, 'unauthorized')
})

test('the service tokens are refused', async ({ request }) => {
  for (const who of ['smoke', 'monitor', 'release'] as Who[]) {
    const r = await call(request, actor(who), 'GET', '/api/skills')
    expect([r.status, r.json?.error?.code], who).toEqual([403, 'forbidden'])
  }
})
