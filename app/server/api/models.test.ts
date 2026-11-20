// Route 38, `GET /api/models` (p3-design 3 and 4.9), on the real migrations. Expected lists are literals. Ways it can
// fail, written down first:
//  1. a model switched off (`tm:<id>:on` = 'off') is listed, or one switched on again isn't;
//  2. the effort ignores the brand's label;
//  3. the default names a model that is off.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { openStores } from '../db/stores.ts'
import { ctx, personPrincipal, reset } from '../db/test-support.ts'
import { listModels } from './models.ts'

const db = env.DB
const stores = openStores(env)
const set = (key: string, value: string) =>
  db.prepare("INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', ?, ?, 1, 0, 'system', ?)").bind(key, JSON.stringify(value), `req-models-${key}`).run()
const list = async (path = '/api/models') => {
  const { c } = ctx(stores, personPrincipal('m_models', 'member'), { method: 'GET', path })
  const res = await listModels(c as never)
  return { status: res.status, body: (await res.json()) as { default: string | null; modes: { id: string; effort: string }[] } }
}

beforeEach(() => reset(db))

describe('route 38', () => {
  it('lists the four models with their default efforts, Opus the default', async () => {
    const { status, body } = await list()
    expect(status).toBe(200)
    expect(body).toEqual({
      default: 'opus',
      modes: [
        { id: 'fable', label: 'Max', model: 'Fable 5.2', sub: 'Hardest problems and long jobs · costs most', effort: 'high' },
        { id: 'opus', label: 'Smart', model: 'Opus 5.5', sub: 'Best for most work', effort: 'medium' },
        { id: 'sonnet', label: 'Fast', model: 'Sonnet 5.5', sub: 'Quick answers, still thinks well · half the cost', effort: 'medium' },
        { id: 'haiku', label: 'Instant', model: 'Haiku 5.5', sub: 'Simple lookups and sorting · costs least', effort: 'low' },
      ],
    })
  })
  it("leaves out what's off, takes the brand's effort label, and moves the default off a model that's off", async () => {
    await set('tm:opus:on', 'off')
    await set('tm:haiku:on', 'on')
    await set('tm:sonnet:effort', 'Extra high')
    const { body } = await list()
    expect(body.modes.map(m => [m.id, m.effort])).toEqual([['fable', 'high'], ['sonnet', 'xhigh'], ['haiku', 'low']])
    expect(body.default).toBe('fable')
  })
  it('every model off: an empty list and no default; a query string is refused', async () => {
    for (const id of ['fable', 'opus', 'sonnet', 'haiku']) await set(`tm:${id}:on`, 'off')
    expect((await list()).body).toEqual({ default: null, modes: [] })
    expect((await list('/api/models?x=1')).status).toBe(400)
  })
})
