// The mock's brand skills (P6a). Ways it can fail, written down first:
//  1. a sample brand skill can't be deleted, one of the Inhouse team's can, or a deleted one comes back on reload;
//  2. a skill made in a chat this session can't be deleted;
//  3. a skill changed in a chat (saved `server.skillsChanged`) doesn't show it, or one of ours is marked changed;
//  4. a brand skill doesn't say the demo's admin may change it, or one of ours does.
import { describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent } = await import('./mock')

const STATE_KEY = 'inhouse.demo.v2'
const BRAND = 'Stuck order nudge'
const fresh = (saved: Record<string, unknown> = {}) => {
  store.clear()
  store.set(STATE_KEY, JSON.stringify(saved))
  return new MockAgent()
}
const names = (a: InstanceType<typeof MockAgent>) => a.read().skills.map(s => s.n)
const errorOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e)

describe('the mock: brand skills', () => {
  it('the sample has one brand skill its admin may change; ours carry no canChange', () => {
    const a = fresh()
    const mine = a.read().skills.filter(s => s.mine)
    expect(mine.map(s => [s.n, s.canChange])).toEqual([[BRAND, true]])
    for (const s of a.read().skills.filter(x => !x.mine)) expect(s.canChange).toBeUndefined()
  })

  it("deletes a sample brand skill (and it stays gone after a reload); refuses one of the Inhouse team's", async () => {
    const a = fresh()
    const ours = a.read().skills.find(s => !s.mine)!.n
    expect(await errorOf(a.deleteSkill(ours))).toMatchObject({ code: 'forbidden' })
    await a.deleteSkill(BRAND)
    expect(names(a)).not.toContain(BRAND)
    expect(names(a)).toContain(ours)
    expect(names(new MockAgent())).not.toContain(BRAND)
  })

  it('deletes a skill made in a chat this session', async () => {
    const made = { n: 'Weekly wholesale report', d: 'Writes it.', icon: 'menu_book', need: 0, by: 'Sam Mercer, in a chat', used: 'New today', mine: true }
    const a = fresh({ skillsExtra: [made] })
    expect(a.getSnapshot().skillsExtra.map(s => s.n)).toEqual([made.n])
    await a.deleteSkill(made.n)
    expect(a.getSnapshot().skillsExtra).toEqual([])
  })

  it('shows when a brand skill was changed in a chat, and never marks one of ours', () => {
    const changed = { iso: '2026-11-20T10:00:00.000Z', ms: Date.parse('2026-11-20T10:00:00.000Z') }
    const ours = fresh().read().skills.find(s => !s.mine)!.n
    const a = fresh({ server: { skillsChanged: { [BRAND]: changed, [ours]: changed } } })
    expect(a.read().skills.find(s => s.n === BRAND)).toMatchObject({ updatedAt: changed, used: 'Changed today' })
    expect(a.read().skills.find(s => s.n === ours)!.used).not.toBe('Changed today')
  })
})
