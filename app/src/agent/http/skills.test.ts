// The Skills page over a fake `fetch` (P6a brand skills: routes 79, 84 and 85). Ways it could show a person the wrong
// thing, written down first:
//  - a skill's page never gets its instructions, or reads them again on every visit;
//  - a refresh of the list drops instructions already read for a skill that hasn't changed, or keeps stale ones for one
//    that has;
//  - Delete is sent without the skill's rev, for one of ours, or leaves the skill listed; a refusal leaves it gone;
//  - the Inhouse team cannot read the skills list on start without a grant (route 79 is technical; route 84's text stays grant-gated).
import { describe, expect, test } from 'vitest'
import { HttpAgent } from './client'
import { me, reads, server } from './testing/fake-server'
import type { Req, Routes } from './testing/fake-server'

const NOW = Date.UTC(2026, 5, 1, 12)
const at = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const OURS = { n: 'pdf', d: 'Makes a PDF.', icon: 'picture_as_pdf', need: 0, by: 'Inhouse team', used: '' }
const brand = (o: Record<string, unknown> = {}) => ({
  n: 'weekly-report', d: 'Writes the weekly report.', icon: 'menu_book', need: 0, by: 'Dana Example', used: '', mine: true,
  updatedAt: at(NOW - 60_000), id: 'bs_AAAAAAAAAAAAAAAAAAAAAA', rev: 2, canChange: true, ...o,
})
const body = (r: Req) => JSON.parse(r.body ?? 'null') as Record<string, unknown>

async function loaded(routes: Routes) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => NOW })
  await agent.whenLoaded()
  return { agent, ...s }
}

describe('the client: skills', () => {
  test("loadSkill reads a skill's instructions once (route 84), and a refresh keeps them while the skill hasn't changed", async () => {
    const page = { body: '# Weekly report\n\nRead the orders.', tools: [], updatedAt: at(NOW - 60_000) }
    let list = [OURS, brand()]
    const { agent, calls } = await loaded({ ...reads(), 'GET /api/skills': () => ({ body: list }), 'GET /api/skills/weekly-report': { body: page } })
    await agent.loadSkill('weekly-report')
    await agent.loadSkill('weekly-report')
    expect(calls.filter(c => c.path === '/api/skills/weekly-report')).toHaveLength(1)
    const shown = () => agent.read().skills.find(s => s.n === 'weekly-report')!
    expect(shown().body).toBe(page.body)
    await agent.refresh('skills')
    expect(shown().body).toBe(page.body)
    // Changed since (a chat saved it again): the old instructions go, so the page reads the new ones.
    list = [OURS, brand({ rev: 3, updatedAt: at(NOW) })]
    await agent.refresh('skills')
    expect(shown().body).toBeUndefined()
    expect(shown().rev).toBe(3)
  })

  test('deleteSkill posts route 85 with the rev and takes it off the list; ours is refused without a call', async () => {
    const { agent, calls } = await loaded({ ...reads(), 'GET /api/skills': { body: [OURS, brand()] }, 'POST /api/skills/brand/bs_AAAAAAAAAAAAAAAAAAAAAA/delete': { body: brand() } })
    await expect(agent.deleteSkill('pdf')).rejects.toMatchObject({ code: 'forbidden' })
    await agent.deleteSkill('weekly-report')
    const post = calls.find(c => c.method === 'POST')!
    expect(post.path).toBe('/api/skills/brand/bs_AAAAAAAAAAAAAAAAAAAAAA/delete')
    expect(body(post)).toEqual({ ifRev: 2 })
    expect(agent.read().skills.map(s => s.n)).toEqual(['pdf'])
  })

  test("a refused delete puts the skill back: another member's (403) as it was, a stale one (409) as the server has it", async () => {
    const forbidden = await loaded({ ...reads(), 'GET /api/skills': { body: [OURS, brand()] }, 'POST /api/skills/brand/bs_AAAAAAAAAAAAAAAAAAAAAA/delete': { status: 403, body: { error: { code: 'forbidden', reason: 'not_owner' } } } })
    await expect(forbidden.agent.deleteSkill('weekly-report')).rejects.toMatchObject({ code: 'forbidden' })
    expect(forbidden.agent.read().skills.map(s => s.n)).toEqual(['pdf', 'weekly-report'])
    const current = brand({ rev: 3, d: 'Writes the weekly report, with returns.' })
    const stale = await loaded({ ...reads(), 'GET /api/skills': { body: [OURS, brand()] }, 'POST /api/skills/brand/bs_AAAAAAAAAAAAAAAAAAAAAA/delete': { status: 409, body: { error: { code: 'conflict', current } } } })
    await expect(stale.agent.deleteSkill('weekly-report')).rejects.toMatchObject({ code: 'conflict' })
    expect(stale.agent.read().skills.find(s => s.n === 'weekly-report')).toMatchObject({ rev: 3, d: current.d })
  })

  test('the Inhouse team reads GET /api/skills on start without a grant, and does not read /api/skills/:name until asked', async () => {
    const { agent, calls } = await loaded({ ...reads(), 'GET /api/me': { body: me({ role: 'inhouse' }) }, 'GET /api/skills': { body: [OURS, brand({ canChange: false })] } })
    expect(calls.map(c => c.path)).toContain('/api/skills')
    expect(calls.some(c => c.path.startsWith('/api/skills/'))).toBe(false)
    expect(agent.read().skills.map(s => [s.n, s.by, s.canChange])).toEqual([
      ['pdf', 'Inhouse team', undefined],
      ['weekly-report', 'Dana Example', false],
    ])
  })
})
