// The team window's requests: open and closed from the same list, the asker's own as "You", a withdrawal moving one to
// Closed, and the account menu's count (`openRequests`) always the window's Open list.
// Ways this could fail, written down before the tests:
//  1. a closed sample request shows as open (or the other way round);
//  2. the signed-in person's request names them instead of "You", so Withdraw never shows;
//  3. a withdrawn request stays in Open, or the menu's count still counts it;
//  4. a request saved before the window dropped "asked by" / "sent by" shows those words as the name;
//  5. a request's status shows a date ("Live by ...") instead of just "With the team";
//  6. two requests share a key (the instant read as "[object Object]"), so withdrawing one moves the other too.
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
    expect(klaviyo).toMatchObject({ kind: 'New tool', who: 'Priya', mine: false})
    expect(klaviyo.status).toBe('With the team')
    expect(wholesale).toMatchObject({ kind: 'New job', who: 'You', mine: true, icon: 'work' })
    expect(wholesale.text).toMatch(/^Every Monday/)
  })

  it('moves a withdrawn request to Closed, and the menu count follows', () => {
    const c = ctx()
    const key = teamRequests(c, now, true).open[1].key
    const { open, closed } = teamRequests(c, now, true, [key])
    expect(open.map(r => r.title)).toEqual(['Connect Klaviyo'])
    expect(closed[0]).toMatchObject({ title: 'Weekly wholesale stock report', status: 'Withdrawn', closed: 'withdrawn' })
    expect(openRequests(c, now, true, [key])).toHaveLength(1)
  })

  it('lists what was sent here first, as yours, and reads an old "sent by" line as the name', () => {
    const sent = { icon: 'bug_report', title: 'Export fails', sub: 'Report a bug · sent by Robin Okafor', at: { iso: new Date(now).toISOString(), ms: now }, status: 'Sent' }
    const { open } = teamRequests(ctx({ teamRequests: [sent] }), now, true)
    expect(open[0]).toMatchObject({ key: teamRequestKey(sent), kind: 'Report a bug', who: 'You', when: 'just now', mine: true })
  })

  it('keys each request by its instant and title, so withdrawing one never moves another, and taking it back restores only it', () => {
    const at = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
    const a = { icon: 'tune', title: 'Same words', sub: 'Change something · Sam Mercer', at: at(now - 60_000), status: 'With the team' }
    const b = { ...a, at: at(now - 120_000) }
    const c = ctx({ teamRequests: [a, b] })
    expect(teamRequestKey(a)).not.toContain('[object')
    expect(teamRequestKey(a)).not.toBe(teamRequestKey(b))
    const before = teamRequests(c, now, true).open.length
    const withdrawn = [teamRequestKey(a)]
    const after = teamRequests(c, now, true, withdrawn)
    expect(after.open).toHaveLength(before - 1)
    expect(after.open.filter(r => r.title === 'Same words').map(r => r.key)).toEqual([teamRequestKey(b)])
    expect(after.closed.filter(r => r.title === 'Same words').map(r => r.key)).toEqual([teamRequestKey(a)])
    // Undo takes that one key back out of `withdrawn`: both are open again.
    const undone = teamRequests(c, now, true, withdrawn.filter(k => k !== teamRequestKey(a)))
    expect(undone.open.filter(r => r.title === 'Same words')).toHaveLength(2)
  })
})
