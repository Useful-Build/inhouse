// The Members page and Data and access as each kind of viewer sees them (fix round 1 of #106). Ways it can fail:
//  1. a member reads as anything but Admin or Member (an "Approver" label, a note about approval rules);
//  2. a Member's Data and access reads the grant (route 16 refuses them) and shows a false "Off";
//  3. an invited person isn't marked on the Members list;
//  4. the demo's Data and access changes (its one switch must stay).
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { settingsPage } = await import('./content')
const { readParts } = await import('./read-text')
const { pageResources } = await import('./allowance')
const { teamRequestLine } = await import('../../state/derive')
type Env = Parameters<typeof settingsPage>[1]

const noop = () => {}
const env = (over: Partial<Env> = {}): Env => ({
  agent: agent.getSnapshot(), data: agent.read(), spent: agent.read().usage.total, phone: false,
  openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
  theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
  me: agent.me(), invite: noop, removeMember: noop, grantUi: false, product: false, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null, exportDataFromServer: null,
  notify: { status: 'idle', list: null, available: null, pickerError: null, pickerLoading: false, truncated: false, canEdit: false, busy: false, add: noop, remove: noop, setAlerts: noop, retry: noop },
  ...over,
})
const rows = (tab: string, e: Env) => settingsPage(tab, e).sections.flatMap(s => s.rows)

describe('a member as text', () => {
  it('reads Admin or Member, whether or not the member is named on an approval rule', () => {
    const members = rows('team-members', env()).filter(r => r.key?.startsWith('p:'))
    // Dana is named on a sample rule: she is a Member all the same.
    expect(readParts(members.find(r => r.title === 'Dana Kim')!, false)).toEqual(['Member'])
    expect(readParts(members.find(r => r.title === 'Sam Mercer')!, false)).toEqual(['Admin'])
    for (const r of members) expect(['Admin', 'Member'], r.title).toContain(readParts(r, false)[0])
  })
  it('says nothing about approval rules on a member, in the row or in the Remove question', () => {
    const members = rows('team-members', env()).filter(r => r.key?.startsWith('p:'))
    const dana = members.find(r => r.title === 'Dana Kim')!
    expect(dana.remove!.text).not.toMatch(/approv|rule/i)
    expect(dana.remove!.text).toBe('Dana loses access to Inhouse. The audit log keeps what Dana did.')
    for (const r of members) { expect(r.display, r.title).toBeUndefined(); expect(r.tag ?? '', r.title).not.toMatch(/approver/i) }
  })
  it('puts no separator before the role of a person with no job title', () => {
    const role = (title: string | null) => {
      const data = agent.read()
      const people = data.people.members.map(m => (m.id === data.meta.currentUser.id ? { ...m, title } : m))
      const e = env({ data: { ...data, people: { ...data.people, members: people }, meta: { ...data.meta, currentUser: { ...data.meta.currentUser, title: title ?? '' } } } })
      return rows('you-general', e).find(r => r.title === 'Role')!.value
    }
    expect(role('Head of Ops')).toMatch(/^Head of Ops · /)
    expect(role(null)).toMatch(/^[A-Z]/)
    expect(role(null)).not.toContain('·')
  })
  it('adds the tag after the label', () => {
    expect(readParts({ title: 't', desc: '', kind: 'select', value: 'Member', need: 0, tag: 'Invited' }, false)).toEqual(['Member', 'Invited'])
  })
})

describe('Data and access for a viewer who cannot see the grant', () => {
  it('reads no grant and shows no grant row', () => {
    expect(pageResources('team-data', false)).toEqual(['members'])
    expect(pageResources('team-data', true)).toEqual(['grants', 'members'])
    expect(rows('team-data', env({ showGrant: false })).some(r => r.title === 'Inhouse team access')).toBe(false)
  })
  it('keeps the demo switch (and the product grant row) for an Admin', () => {
    const demo = rows('team-data', env()).find(r => r.title === 'Inhouse team access')!
    expect(demo.kind).toBe('toggle')
    expect(rows('team-data', env({ grantUi: true })).find(r => r.title === 'Inhouse team access')!.kind).toBe('grant')
  })
})

describe('an invited member', () => {
  it('shows an Invited tag, and nobody else does', async () => {
    await agent.inviteMember({ name: 'Robin Lee', email: 'robin@example.test', role: 'member' })
    const members = rows('team-members', env({ data: agent.read(), agent: agent.getSnapshot() })).filter(r => r.key?.startsWith('p:'))
    expect(members.find(r => r.title === 'Robin Lee')?.tag).toBe('Invited')
    expect(members.filter(r => r.tag === 'Invited')).toHaveLength(1)
  })
})

describe('a sent team request (TeamWindow passes `demo !== null` as sentHere)', () => {
  const now = Date.parse('2026-11-16T17:00:00Z')
  const q = { title: 't', sub: 'New tool · sent by Sam', at: { iso: '2026-11-16T12:00:00.000Z', ms: Date.parse('2026-11-16T12:00:00Z') }, status: 'Sent' }
  it('says just now in the demo and how long ago in the product', () => {
    expect(teamRequestLine(q, now, true).sub).toBe('New tool · sent by Sam, just now')
    expect(teamRequestLine(q, now, false).sub).not.toContain('just now')
  })
})
