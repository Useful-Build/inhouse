// Settings, Slack notices in the product (Stage 1 M3-C, N27; the M2 carry-over from #449): before `slack.channel.post`
// opens, the page says that marking a channel for alerts gives the agent a standing permission to post there. Ways it
// can fail:
//  1. an admin can mark a channel for alerts while posting is on without the page saying, in N27's words and before the
//     save, that the mark lets the agent post there without asking, up to the effective daily limit;
//  2. the limit shown isn't the one the server says is in force (the list's `posting.perDay`, or the grant's own);
//  3. while posting is off the page shows a limit as live, or doesn't say "once posting is switched on";
//  4. the alerts channel's row doesn't say whether a standing permission exists now, or an admin can't reach Always
//     allowed from it to remove it (or someone who can't remove it there is sent there);
//  5. the Inhouse team is told its own mark gives a permission (only an admin's does, D4);
//  6. the demo's page changes.
import { describe, expect, it, vi } from 'vitest'
import type { Me } from '../../../shared/contract/me'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { alertsDisclosure, settingsPage } = await import('./content')
type Env = Parameters<typeof settingsPage>[1]
type View = Env['notify']
type List = NonNullable<View['list']>

const noop = () => {}
const ON = { on: true, perDay: 20 } as const
const OFF = { on: false } as const
const PERMISSION = { id: 'pg_AAAAAAAAAAAAAAAAAAAAAA', scope: '#ops-alerts', perDay: 20 }
const list = (posting: List['posting'], permission = false): List => ({
  rev: 4, posting,
  channels: [{ channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true, ...(permission ? { permission: PERMISSION } : {}) }, { channelId: 'C0TEST0002', name: 'general', alerts: false }],
})
const view = (l: List, canEdit = true): View => ({
  status: 'ready', list: l, available: [], pickerError: null, pickerLoading: false, truncated: false, canEdit, busy: false,
  add: noop, remove: noop, setAlerts: noop, retry: noop,
})
const meAs = (role: Me['role']): Me => ({ ...agent.me()!, role, grant: null })
function page(v: View, role: Me['role'], product = true) {
  const opened: string[] = []
  const e: Env = {
    S: 2, stage: 'Run', agent: agent.getSnapshot(), data: { ...agent.read(), tools: { ...agent.read().tools, connected: ['slack'] } }, spent: agent.read().usage.total, phone: false,
    openTeam: noop, openPop: noop, openSettings: t => opened.push(t), newChat: noop, goSkills: noop, togglePause: noop,
    theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
    me: meAs(role), invite: noop, removeMember: noop, grantUi: false, product, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null, exportDataFromServer: null, notify: v,
  }
  const p = settingsPage('team-slack', e)
  return { rows: p.sections.flatMap(s => s.rows), opened }
}
const N27 = (n: number) => `Marking this channel lets the agent post here without asking, up to ${n} posts a day. Approvals, questions and problems post here too.`

describe('marking a channel for alerts (failures 1, 2 and 5)', () => {
  it("an admin reads N27's words with the effective limit beside the choice, and is asked before a new mark saves", () => {
    const { rows } = page(view(list(ON)), 'admin')
    const alerts = rows.find(r => r.title === 'Alerts channel')!
    expect(alerts.desc).toBe(N27(20))
    expect(alerts.confirm!('#general')).toEqual({ title: 'Mark #general for alerts?', text: N27(20), action: 'Mark for alerts' })
    // Keeping the mark where it is, or taking it off, gives nothing: no question.
    expect(alerts.confirm!('#ops-alerts')).toBeNull()
    expect(alerts.confirm!('None')).toBeNull()
  })
  it('the limit is the one the list says (the smaller of the grant and the ceiling, worked out by the server)', () => {
    for (const perDay of [1, 50, 1200]) expect(page(view(list({ on: true, perDay })), 'admin').rows.find(r => r.title === 'Alerts channel')!.desc).toBe(N27(perDay))
  })
  it("the Inhouse team is told its mark gives no permission, and isn't asked", () => {
    const alerts = page(view(list(ON)), 'inhouse').rows.find(r => r.title === 'Alerts channel')!
    expect(alerts.desc).toBe("Approvals, questions and problems post here. Marking it gives no permission: only an admin's mark lets the agent post here without asking.")
    expect(alerts.confirm).toBeUndefined()
  })
})

describe('while posting is off (failure 3)', () => {
  it('says "once posting is switched on", shows no number and asks nothing', () => {
    const { rows } = page(view(list(OFF)), 'admin')
    const alerts = rows.find(r => r.title === 'Alerts channel')!
    expect(alerts.desc).toBe('Approvals, questions and problems post here. Once posting is switched on, marking a channel lets the agent post there without asking.')
    expect(alerts.confirm).toBeUndefined()
    const row = rows.find(r => r.title === '#ops-alerts')!
    expect(row.desc).toContain('once posting is switched on')
    for (const r of rows) expect(`${r.title} ${r.desc}`, r.title).not.toMatch(/\d+ posts? a day/)
    expect(alertsDisclosure(OFF, 'admin')).not.toMatch(/\d/)
  })
})

describe("the alerts channel's row (failure 4)", () => {
  it('with a standing permission: says so with its limit, and an admin gets a way to Always allowed', () => {
    const { rows, opened } = page(view(list(ON, true)), 'admin')
    expect(rows.find(r => r.title === '#ops-alerts')!.desc).toBe('The alerts channel. Standing permission: the agent posts here without asking, up to 20 posts a day. Approvals, questions and problems post here too.')
    const held = rows.find(r => r.title === 'Standing permission')!
    expect([held.kind, held.value, held.desc]).toEqual(['button', 'Open Always allowed', 'To stop the agent posting to #ops-alerts without asking, remove it in Always allowed.'])
    held.onClick!()
    expect(opened).toEqual(['you-permissions'])
  })
  it("a member and the Inhouse team read that it exists, with no button to a list they can't remove it from", () => {
    for (const role of ['member', 'inhouse'] as const) {
      const held = page(view(list(ON, true), role === 'inhouse'), role).rows.find(r => r.title === 'Standing permission')!
      expect([held.kind, held.desc], role).toEqual(['value', "An admin can remove the agent's standing permission to post to #ops-alerts."])
    }
  })
  it('without one: says the agent asks first while posting is on; no Standing permission row', () => {
    const { rows } = page(view(list(ON)), 'member')
    expect(rows.find(r => r.title === '#ops-alerts')!.desc).toBe('The alerts channel. Approvals, questions and problems post here. No standing permission: the agent asks before it posts here.')
    expect(rows.some(r => r.title === 'Standing permission')).toBe(false)
    expect(rows.find(r => r.title === 'Agent posts')!.desc).toContain('unless it has a standing permission there')
  })
})

describe('the demo (failure 6)', () => {
  it('keeps its own words whatever the list says', () => {
    for (const posting of [ON, OFF]) {
      const { rows } = page(view(list(posting, true)), 'admin', false)
      expect(rows.find(r => r.title === 'Alerts channel')!.desc).toBe('Where approvals, questions and problems are posted.')
      expect(rows.find(r => r.title === '#ops-alerts')!.desc).toBe('The alerts channel. Approvals, questions and problems post here too.')
      expect(rows.some(r => r.title === 'Standing permission')).toBe(false)
      expect(rows.find(r => r.title === 'Alerts channel')!.confirm).toBeUndefined()
    }
  })
})
