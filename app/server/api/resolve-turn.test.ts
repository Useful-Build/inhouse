// PR 5, ask F: route 29's model and settings resolution as one function (route 29 itself runs it: runs.test.ts). Every
// expected value is a literal from the catalogue's published ids and the settings keys of design 4.9. Ways it can fail:
// an unknown model isn't `invalid`; a switched-off model runs; the effort, side model, turn budget or WebFetch hosts
// don't follow the settings; a broken stored host list allows any host instead of none; an empty or missing list allows
// any host (P8a S: it allows none); web search is on without the brand's `t:websearch` switch; a fetch host is left
// while the brand's `t:webfetch_on` is off (M1-F: both switches are brand settings, so both scopes are read).
import { describe, expect, it } from 'vitest'
import type { SettingRecord } from '../../shared/contract/settings.ts'
import { settingSpec } from '../../shared/contract/settings.ts'
import { resolveTurnSettings } from './runs.ts'

/** The settings store: each value listed under its own key's scope, as the real store lists them. */
const store = (values: Record<string, unknown>) => ({
  list: async (owner: string, scope: string) => {
    expect(owner).toBe('brand')
    expect(['brand', 'technical']).toContain(scope)
    return Object.entries(values).filter(([key]) => settingSpec(key)?.scope === scope).map(([key, value]): SettingRecord => ({ key, value: value as SettingRecord['value'], rev: 1, updatedAt: null, updatedBy: null }))
  },
})

describe('resolveTurnSettings (F)', () => {
  it('defaults: the catalogue effort, Haiku as the side model, 25 turns, no WebFetch host, web search off', async () => {
    expect(await resolveTurnSettings(store({}), 'sonnet')).toEqual({
      model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium', sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: [], webSearch: false,
    })
    expect(await resolveTurnSettings(store({ 't:webfetch': '' }), 'sonnet')).toMatchObject({ webFetchDomains: [], webSearch: false })
  })

  it('web search only with the switch on (true); anything else is off', async () => {
    expect(await resolveTurnSettings(store({ 't:websearch': true }), 'sonnet')).toMatchObject({ webSearch: true })
    for (const v of [false, null, 'true', 'on', 1]) expect(await resolveTurnSettings(store({ 't:websearch': v }), 'sonnet'), String(v)).toMatchObject({ webSearch: false })
  })

  it('reading web pages off leaves no fetch host whatever the list; on, reset or missing lets the list decide', async () => {
    const hosts = 'example.com\ndocs.example.org'
    for (const v of [false, 'false', 0, 'off']) expect(await resolveTurnSettings(store({ 't:webfetch': hosts, 't:webfetch_on': v }), 'sonnet'), String(v)).toMatchObject({ webFetchDomains: [] })
    for (const v of [true, null, undefined]) expect(await resolveTurnSettings(store({ 't:webfetch': hosts, ...(v === undefined ? {} : { 't:webfetch_on': v }) }), 'sonnet'), String(v)).toMatchObject({ webFetchDomains: ['example.com', 'docs.example.org'] })
  })

  it('follows the settings: effort label, Haiku off, the turn budget and a host list', async () => {
    expect(await resolveTurnSettings(store({ 'tm:opus:effort': 'Highest', 'tm:haiku:on': 'off', 't:max_turns': '50', 't:webfetch': 'example.com\ndocs.example.org' }), 'opus')).toEqual({
      model: 'claude-opus-5-5', pickerId: 'opus', effort: 'max', sideModel: 'claude-opus-5-5', maxTurns: 50, webFetchDomains: ['example.com', 'docs.example.org'], webSearch: false,
    })
  })

  it('refuses an unknown model and a switched-off one; a broken host list allows no host', async () => {
    expect(await resolveTurnSettings(store({}), 'gpt')).toEqual({ refused: { code: 'invalid' } })
    expect(await resolveTurnSettings(store({ 'tm:sonnet:on': 'off' }), 'sonnet')).toEqual({ refused: { code: 'forbidden', reason: 'model_off' } })
    expect(await resolveTurnSettings(store({ 't:webfetch': 'not a host!', 't:max_turns': '7' }), 'sonnet')).toMatchObject({ webFetchDomains: [], maxTurns: 25 })
  })
})
