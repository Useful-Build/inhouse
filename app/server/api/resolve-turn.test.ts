// PR 5, ask F: route 29's model and settings resolution as one function (route 29 itself runs it: runs.test.ts). Every
// expected value is a literal from the catalogue's published ids and the settings keys of design 4.9. Ways it can fail:
// an unknown model isn't `invalid`; a switched-off model runs; the effort, side model, turn budget or WebFetch hosts
// don't follow the settings; a broken stored host list allows any host instead of none.
import { describe, expect, it } from 'vitest'
import type { SettingRecord } from '../../shared/contract/settings.ts'
import { resolveTurnSettings } from './runs.ts'

const store = (values: Record<string, string>) => ({
  list: async (owner: string, scope: string) => {
    expect([owner, scope]).toEqual(['brand', 'technical'])
    return Object.entries(values).map(([key, value]): SettingRecord => ({ key, value, rev: 1, updatedAt: null, updatedBy: null }))
  },
})

describe('resolveTurnSettings (F)', () => {
  it('defaults: the catalogue effort, Haiku as the side model, 25 turns, any public host', async () => {
    expect(await resolveTurnSettings(store({}), 'sonnet')).toEqual({
      model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium', sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: null,
    })
  })

  it('follows the settings: effort label, Haiku off, the turn budget and a host list', async () => {
    expect(await resolveTurnSettings(store({ 'tm:opus:effort': 'Highest', 'tm:haiku:on': 'off', 't:max_turns': '50', 't:webfetch': 'example.com\ndocs.example.org' }), 'opus')).toEqual({
      model: 'claude-opus-5-5', pickerId: 'opus', effort: 'max', sideModel: 'claude-opus-5-5', maxTurns: 50, webFetchDomains: ['example.com', 'docs.example.org'],
    })
  })

  it('refuses an unknown model and a switched-off one; a broken host list allows no host', async () => {
    expect(await resolveTurnSettings(store({}), 'gpt')).toEqual({ refused: { code: 'invalid' } })
    expect(await resolveTurnSettings(store({ 'tm:sonnet:on': 'off' }), 'sonnet')).toEqual({ refused: { code: 'forbidden', reason: 'model_off' } })
    expect(await resolveTurnSettings(store({ 't:webfetch': 'not a host!', 't:max_turns': '7' }), 'sonnet')).toMatchObject({ webFetchDomains: [], maxTurns: 25 })
  })
})
