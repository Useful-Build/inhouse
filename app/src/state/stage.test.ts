import { describe, expect, it } from 'vitest'
import { productStage } from './stage'

describe('productStage', () => {
  it('gives the stage setting to consumers', () => {
    expect(productStage({ stage: 'Watch' })).toBe('Watch')
    expect(productStage({ stage: 'Run' })).toBe('Run')
  })
  it('follows a change of the setting', () => {
    const before = productStage({ stage: 'Watch' })
    const after = productStage({ stage: 'Act' })
    expect([before, after]).toEqual(['Watch', 'Act'])
  })
  it('fails closed to Watch on a missing or unknown value', () => {
    expect(productStage({})).toBe('Watch')
    expect(productStage({ stage: 'Sprint' })).toBe('Watch')
    expect(productStage({ stage: '' })).toBe('Watch')
  })
})
