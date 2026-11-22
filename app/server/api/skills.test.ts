// Route 79, `GET /api/skills` (P6a W3). Ways it can fail, written first: the list isn't the four literals below (an extra,
// a missing one, a stage tag on any); a query string is accepted.
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { openStores } from '../db/stores.ts'
import { ctx, personPrincipal } from '../db/test-support.ts'
import { listSkills } from './skills.ts'

const stores = openStores(env)
const get = async (path: string) => {
  const { c } = ctx(stores, personPrincipal('m_skills', 'member'), { method: 'GET', path })
  const res = await listSkills(c as never)
  return { status: res.status, body: await res.json() }
}

describe('route 79', () => {
  it('lists dataviz and our three, none with a stage tag', async () => {
    const { status, body } = await get('/api/skills')
    expect(status).toBe(200)
    expect((body as { n: string; need: number; by: string }[]).map(s => [s.n, s.need, s.by])).toEqual([
      ['dataviz', 0, 'Inhouse team'], ['pdf', 0, 'Inhouse team'], ['word', 0, 'Inhouse team'], ['spreadsheet', 0, 'Inhouse team'],
    ])
  })
  it('refuses a query string', async () => {
    expect((await get('/api/skills?x=1')).status).toBe(400)
  })
})
