// A brand with no Slack (the data override: no connected channel) has no Slack post, as the product can't make one. Ways it
// could break, written first:
//  1. one of Today's two Slack posts (payout, stuck order) is still a post, with a draft and an Approve;
//  2. the finding that replaces it keeps the post's words ("Slack post", "#ops-alerts"), or a draft;
//  3. the Slack ask card or its permission still shows.
// e2e/brand-data.spec.ts checks the pages; this fails first, without a browser.
import { describe, expect, it, vi } from 'vitest'
import { hasDraft } from '../state/derive'

const store = new Map<string, string>([['inhouse.demo.data.v1', JSON.stringify({ channels: false })]])
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('./mock')

describe('a brand with no Slack', () => {
  it('has no Slack post on Today: the payout and the stuck order are findings with their suggestion and no draft', () => {
    const a = new MockAgent()
    for (const id of ['payout', 'stuck']) {
      const p = a.read().problems.find(x => x.id === id)!
      expect(hasDraft(p), id).toBe(false)
      expect(p.draft.kind, id).toBeUndefined()
      expect(JSON.stringify(p.draft), id).not.toMatch(/Slack|#ops-alerts/)
    }
    // A real Shopify draft stays.
    expect(hasDraft(a.read().problems.find(x => x.id === 'returns')!)).toBe(true)
  })

  it('has no Slack ask card and no Slack permission', async () => {
    const a = new MockAgent()
    expect((await a.actions()).some(c => c.tool.label === 'Slack' || /Slack/.test(c.title))).toBe(false)
    expect((await a.permissions()).some(p => p.tool.label === 'Slack' || /channel/i.test(p.title))).toBe(false)
  })
})
