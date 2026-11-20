// The model catalogue and `resolveModel` (p3-design 4.9). Expected values are literals here. Ways it can fail, written
// down first:
//  1. a model switched off (`tm:<id>:on` = 'off') or unpriced still runs; or one that's on (missing key, 'on') is refused;
//  2. an unknown picker id is anything but `invalid`;
//  3. the effort ignores the brand's label, or a label maps to the wrong effort;
//  4. the background model is Haiku when Haiku is off or unpriced (it must fall back to the turn's model).
import { describe, expect, it } from 'vitest'
import { CATALOG, resolveModel } from './catalog.ts'
import type { CatalogModel, Price } from './catalog.ts'

const price: Price = { tiers: [{ uptoInputTokens: null, input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 }], fastModeMultiplier: null, geoMultipliers: {}, webSearchPerUse: 1 }
const priced: CatalogModel[] = CATALOG.map(m => ({ ...m, price }))
const resolve = (id: string, settings: Record<string, string | boolean | null> = {}, catalog: CatalogModel[] = priced) => resolveModel(id, settings, catalog)
const OFF = { refused: { code: 'forbidden', reason: 'model_off' } }

describe('the catalogue', () => {
  it('lists the four models with their API ids and default efforts', () => {
    expect(CATALOG.map(m => [m.id, m.label, m.apiId, m.defaultEffort])).toEqual([
      ['fable', 'Max', 'claude-fable-5-2', 'high'], ['opus', 'Smart', 'claude-opus-5-5', 'medium'],
      ['sonnet', 'Fast', 'claude-sonnet-5-5', 'medium'], ['haiku', 'Instant', 'claude-haiku-5-5', 'low'],
    ])
  })
  it('prices every model, so each one runs while it is on (W3 filled the prices)', () => {
    for (const m of CATALOG) expect(resolveModel(m.id, {}), m.id).toMatchObject({ model: { id: m.id } })
    for (const m of CATALOG) expect(resolveModel(m.id, { [`tm:${m.id}:on`]: 'off' }), m.id).toEqual(OFF)
  })
})

describe('resolveModel (failures 1-4)', () => {
  it('on unless tm:<id>:on is exactly off', () => {
    expect(resolve('sonnet')).toMatchObject({ model: { id: 'sonnet' } })
    expect(resolve('sonnet', { 'tm:sonnet:on': 'on' })).toMatchObject({ model: { id: 'sonnet' } })
    expect(resolve('sonnet', { 'tm:sonnet:on': 'off' })).toEqual(OFF)
    expect(resolve('sonnet', { 'tm:opus:on': 'off' })).toMatchObject({ model: { id: 'sonnet' } })
  })
  it('refuses an unpriced model and an unknown id', () => {
    expect(resolve('opus', {}, priced.map(m => (m.id === 'opus' ? { ...m, price: null } : m)))).toEqual(OFF)
    for (const id of ['gpt', '', 'Sonnet', 'claude-sonnet-5-5']) expect(resolve(id), id).toEqual({ refused: { code: 'invalid' } })
  })
  it("uses the brand's effort label, else the default", () => {
    expect(resolve('fable')).toMatchObject({ effort: 'high' })
    const cases: [string, string][] = [['Low', 'low'], ['Medium', 'medium'], ['High', 'high'], ['Extra high', 'xhigh'], ['Highest', 'max']]
    for (const [label, effort] of cases) expect(resolve('haiku', { 'tm:haiku:effort': label }), label).toMatchObject({ effort })
    expect(resolve('haiku', { 'tm:haiku:effort': 'Turbo' })).toMatchObject({ effort: 'low' })
    expect(resolve('haiku', { 'tm:sonnet:effort': 'Highest' })).toMatchObject({ effort: 'low' })
  })
  it('sends background calls to Haiku when it is on and priced, else to the turn model', () => {
    expect(resolve('opus')).toMatchObject({ sideApiId: 'claude-haiku-5-5' })
    expect(resolve('opus', { 'tm:haiku:on': 'off' })).toMatchObject({ sideApiId: 'claude-opus-5-5' })
    expect(resolve('opus', {}, priced.map(m => (m.id === 'haiku' ? { ...m, price: null } : m)))).toMatchObject({ sideApiId: 'claude-opus-5-5' })
  })
})
