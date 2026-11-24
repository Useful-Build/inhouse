// The Members page and Data and access as each kind of viewer sees them (fix round 1 of #106). Ways it can fail:
//  1. a Member named on an approval rule reads "Member" as text, where the demo reads "Approver";
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
  S: 2, stage: 'Run', agent: agent.getSnapshot(), data: agent.read(), spent: agent.read().usage.total, phone: false,
  openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
  theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
  me: agent.me(), invite: noop, removeMember: noop, grantUi: false, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null, exportDataFromServer: null,
  ...over,
})
const rows = (tab: string, e: Env) => settingsPage(tab, e).sections.flatMap(s => s.rows)

describe('the Approver label as text', () => {
  it('reads Approver for a Member named on a rule, and Admin and Member otherwise', () => {
    const members = rows('team-members', env()).filter(r => r.key?.startsWith('p:'))
    const dana = members.find(r => r.title === 'Dana Kim')!
    expect(readParts(dana, false)).toEqual(['Approver'])
    expect(readParts(members.find(r => r.title === 'Sam Mercer')!, false)).toEqual(['Admin'])
    expect(members.some(r => readParts(r, false)[0] === 'Member')).toBe(true)
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
