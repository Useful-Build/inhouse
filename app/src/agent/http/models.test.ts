// The client's model catalogue against the server's (a differential test: the two lists are written apart and must agree),
// and which models the picker and the Models page list.
import { describe, expect, test } from 'vitest'
import { CATALOG } from '../../../server/model/catalog'
import { MODEL_CATALOG, listedModels } from './models'

describe('the catalogue the Models page lists', () => {
  test('matches the server\'s catalogue: ids, labels, names, lines and default efforts, strongest first', () => {
    expect(MODEL_CATALOG).toEqual(CATALOG.map(m => ({ id: m.id, label: m.label, model: m.name, sub: m.sub, effort: m.defaultEffort })))
  })
})

describe('listedModels', () => {
  const served = { default: 'opus', modes: MODEL_CATALOG.filter(m => m.id !== 'fable' && m.id !== 'haiku').map(m => ({ ...m, effort: 'high' as const })) }
  test('nothing read yet lists nothing', () => { expect(listedModels(null, {})).toEqual([]) })
  test('the served models with the effort the server gave, in catalogue order', () => {
    expect(listedModels(served, {}).map(m => [m.id, m.effort])).toEqual([['opus', 'high'], ['sonnet', 'high']])
  })
  test('a model that is switched off and not served stays listed (so it can be switched on); an unserved one that is not off does not', () => {
    expect(listedModels(served, { 'tm:fable:on': 'off' }).map(m => m.id)).toEqual(['fable', 'opus', 'sonnet'])
    expect(listedModels(served, { 'tm:fable:on': 'on' }).map(m => m.id)).toEqual(['opus', 'sonnet'])
  })
  test('a model the server serves that this build doesn\'t know goes last', () => {
    const extra = { id: 'new', label: 'New', model: 'New 1', sub: 'x', effort: 'low' as const }
    expect(listedModels({ default: 'opus', modes: [...served.modes, extra] }, {}).map(m => m.id)).toEqual(['opus', 'sonnet', 'new'])
  })
})
