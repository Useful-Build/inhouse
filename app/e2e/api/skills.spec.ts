// Skills (P6a acceptance 7, route 79). Every role sees the five built-in skills, each with no stage tag at Watch.
// The built-ins precede any brand skills, whose access and metadata are covered in brand-skills.spec.ts.
// This spec uses the API and runs on deployed test builds too.
import { expect, test } from '@playwright/test'
import { actor, call, expectError } from './kit.ts'
import type { Who } from './kit.ts'

const BUILT_INS = ['dataviz', 'pdf', 'word', 'spreadsheet', 'skill-creator']

for (const who of ['admin', 'memberA', 'memberB', 'inhouse'] as Who[]) {
  test(`${who} gets all five built-in skills first, none with a stage`, async ({ request }) => {
    const r = await call(request, actor(who), 'GET', '/api/skills')
    expect(r.status, r.text).toBe(200)
    const skills = r.json as { n: string; d: string; icon: string; need: number; by: string; mine?: boolean }[]
    const builtIns = skills.filter(s => s.mine !== true)
    expect(builtIns.map(s => s.n)).toEqual(BUILT_INS)
    expect(skills.slice(0, BUILT_INS.length)).toEqual(builtIns)
    for (const s of builtIns) {
      expect(s.need, `${s.n} shows no stage tag at Watch`).toBe(0)
      expect(s.by).toBe('Inhouse team')
      expect(s).not.toHaveProperty('mine')
      expect(s.d.length, `${s.n} has a description`).toBeGreaterThan(0)
      expect(s.icon.length, `${s.n} has an icon`).toBeGreaterThan(0)
    }
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
