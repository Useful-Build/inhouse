// The product-only behaviour of the Skills page as pure decisions, since the repo has no DOM test setup (no jsdom or
// testing library; adding one is an orchestrator change to package.json). Ways it can fail, written first: the product
// keeps the "By your team" tab or the "Works from" row it has no use for, or the demo loses them.
import { describe, expect, it } from 'vitest'
import { shownSkillTab, skillFacts, skillTabs } from './product-flow'

describe('the Skills page', () => {
  it('the product offers All and By Inhouse team only; the demo keeps all three', () => {
    expect(skillTabs(true).map(([k]) => k)).toEqual(['all', 'team', 'mine'])
    expect(skillTabs(false).map(([k]) => k)).toEqual(['all', 'team'])
  })
  it('a saved "By your team" tab shows as All on the product, and as itself in the demo', () => {
    expect(shownSkillTab(false, 'mine')).toBe('all')
    expect(shownSkillTab(false, 'team')).toBe('team')
    expect(shownSkillTab(true, 'mine')).toBe('mine')
  })
  it('"Works from" is dropped on the product at need 0, kept there above 0 and always in the demo; "Used" only when there is one', () => {
    const labels = (product: boolean, need: 0 | 1 | 2, used = '') => skillFacts(product, { used, by: 'Inhouse team', need }, n => `S${n}`).map(([k]) => k)
    expect(labels(false, 0)).toEqual(['Made by'])
    expect(labels(false, 1)).toEqual(['Made by', 'Works from'])
    expect(labels(true, 0)).toEqual(['Made by', 'Works from'])
    expect(labels(false, 0, 'Weekly')).toEqual(['Used', 'Made by'])
  })
})
