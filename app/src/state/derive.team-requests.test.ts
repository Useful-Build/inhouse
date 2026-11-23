// The team window's requests: open and closed from the same list, the asker's own as "You", a withdrawal moving one to
// Closed, and the account menu's count (`openRequests`) always the window's Open list.
// Ways this could fail, written down before the tests:
//  1. a closed sample request shows as open (or the other way round);
//  2. the signed-in person's request names them instead of "You", so Withdraw never shows;
//  3. a withdrawn request stays in Open, or the menu's count still counts it;
//  4. a request saved before the window dropped "asked by" / "sent by" shows those words as the name;
//  5. "Connect Klaviyo" loses its "Live by" date.
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../agent')
const { openRequests, teamRequestKey, teamRequests } = await import('./derive')
type Ctx = Parameters<typeof teamRequests>[0]

const ctx = (over: Partial<Ctx['agent']> = {}): Ctx => ({ S: 1, agent: { ...agent.getSnapshot(), ...over }, data: agent.read() })
const now = Date.now()

describe('team requests', () => {
  it('splits the sample requests into open and closed, with the asker as "You" on their own', () => {
    const { open, closed } = teamRequests(ctx(), now, true)
    expect(open.map(r => r.title)).toEqual(['Connect Klaviyo', 'Weekly wholesale stock report'])
    expect(closed.map(r => [r.title, r.status])).toEqual([['Connect Gorgias', 'Done'], ['Morning check skips Faire orders', 'Done'], ['Reply to Instagram comments', 'Declined']])
    const [klaviyo, wholesale] = open
    expect(klaviyo).toMatchObject({ kind: 'New tool', who: 'Priya', mine: false, dated: true })
    expect(klaviyo.status).toMatch(/^Live by /)
    expect(wholesale).toMatchObject({ kind: 'New job', who: 'You', mine: true, icon: 'work' })
    expect(wholesale.text).toMatch(/^Every Monday/)
  })

  it('moves a withdrawn request to Closed, and the menu count follows', () => {
    const c = ctx()
    const key = teamRequests(c, now, true).open[1].key
    const { open, closed } = teamRequests(c, now, true, [key])
    expect(open.map(r => r.title)).toEqual(['Connect Klaviyo'])
    expect(closed[0]).toMatchObject({ title: 'Weekly wholesale stock report', status: 'Withdrawn', closed: 'withdrawn', dated: false })
    expect(openRequests(c, now, true, [key])).toHaveLength(1)
  })

  it('lists what was sent here first, as yours, and reads an old "sent by" line as the name', () => {
    const sent = { icon: 'bug_report', title: 'Export fails', sub: 'Report a bug · sent by Robin Okafor', at: { iso: new Date(now).toISOString(), ms: now }, status: 'Sent' }
    const { open } = teamRequests(ctx({ teamRequests: [sent] }), now, true)
    expect(open[0]).toMatchObject({ key: teamRequestKey(sent), kind: 'Report a bug', who: 'You', when: 'just now', mine: true })
  })
})
