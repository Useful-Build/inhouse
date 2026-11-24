// Data and access (P8a D): the retention row and Export everything, as each kind of viewer sees them. Ways it can fail:
//  1. an Admin or a Member gets a retention dropdown (the Inhouse team sets the periods), or isn't told who sets them;
//  2. the Inhouse team gets the periods as text;
//  3. Next cleanup isn't the nightly cleanup's time (03:30 UTC) shown in the brand's time, or shows a past time;
//  4. a Member is offered Export everything (route 95 is Admins and the Inhouse team under a grant);
//  5. the product's Export builds a file in the page instead of starting the server's download, or the demo's reaches a
//     server or holds no sample;
//  5b. the product says the export is downloading before its check (route 96) passed, or a refusal (too big, a grant
//     that ended, storage down) shows nothing, or raw text, instead of a plain sentence;
//  6. the demo's sample isn't the product export's shape: no header first, no end line last, or counts that disagree.
import { describe, expect, it, vi } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { CAN_KEYS } from '../../../shared/contract/keys'
import { nextCleanupMs } from '../../../shared/contract/data-access'
import type { Can, Me, MemberRecord } from '../../agent/types'
import { AgentError } from '../../agent/types'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { exportRefused, settingsPage } = await import('./content')
const { allowance } = await import('./allowance')
const { demoExport } = await import('./demo-export')
const { fmtTime } = await import('../../lib/format')
const { display, nowOf } = await import('../../state/display')
type Env = Parameters<typeof settingsPage>[1]

const noop = () => {}
const env = (over: Partial<Env> = {}): Env => ({
  S: 2, stage: 'Run', agent: agent.getSnapshot(), data: agent.read(), spent: agent.read().usage.total, phone: false,
  openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
  theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
  me: agent.me(), invite: noop, removeMember: noop, grantUi: false, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null,
  exportDataFromServer: null,
  notify: { status: 'idle', list: null, available: null, pickerError: null, pickerLoading: false, truncated: false, canEdit: false, busy: false, add: noop, remove: noop, setAlerts: noop, retry: noop },
  ...over,
})
const rows = (e: Env) => settingsPage('team-data', e).sections.flatMap(s => s.rows)
const row = (e: Env, title: string) => {
  const r = rows(e).find(x => x.title === title)
  if (!r) throw new Error(`no row ${title}`)
  return r
}
/** A signed-in viewer with these `can` keys (the server's answers for each role, server/auth/matrix.test.ts). */
const viewer = (role: Me['role'], on: readonly string[]): Me => ({
  ...agent.me()!, role, can: Object.fromEntries(CAN_KEYS.map(k => [k, on.includes(k)])) as Can,
})
const ADMIN = viewer('admin', ['invite', 'changeRole', 'remove', 'editBrandSettings', 'switchModel', 'grantSupport', 'viewMembers', 'viewAudit', 'exportAudit', 'approveMemory', 'exportData'])
const MEMBER = viewer('member', ['viewMembers', 'viewAudit', 'exportAudit'])
const INHOUSE = viewer('inhouse', ['invite', 'remove', 'editBrandSettings', 'editTechnical', 'switchModel', 'viewMembers'])

describe('the retention row', () => {
  it.each([['an Admin', ADMIN], ['a Member', MEMBER]] as const)('%s reads both periods as text, told the Inhouse team sets them', (_, me) => {
    for (const title of ['Chats', 'Activity and steps']) {
      const r = row(env({ me }), title)
      expect(allowance(r, me.can, true, me.role).control, title).toBe(false)
      expect(r.desc, title).toMatch(/ The Inhouse team sets this\.$/)
    }
  })
  it('the Inhouse team gets both dropdowns, with the five periods, and no "sets this" line', () => {
    for (const title of ['Chats', 'Activity and steps']) {
      const r = row(env({ me: INHOUSE }), title)
      expect(allowance(r, INHOUSE.can, true, 'inhouse').control, title).toBe(true)
      expect(r.options).toEqual(['3 months', '6 months', '12 months', '24 months', 'Until deleted'])
      expect(r.desc).not.toContain('Inhouse team')
    }
  })
  it('shows the next nightly cleanup, at 03:30 UTC in the brand\'s time, still to come', () => {
    const r = row(env(), 'Next cleanup')
    expect(r.kind).toBe('value')
    const at = nextCleanupMs(nowOf())
    expect(at).toBeGreaterThan(nowOf())
    expect(r.value.endsWith(` at ${fmtTime(at, display())}`)).toBe(true)
    expect(r.value).toMatch(/^[A-Z]/)
  })
})

describe('Export everything', () => {
  it('is offered to an Admin and the Inhouse team under a grant, never to a Member', () => {
    const r = row(env(), 'Export everything')
    expect(r.can).toBe('exportData')
    expect(allowance(r, ADMIN.can, true, 'admin').control).toBe(true)
    expect(allowance(r, MEMBER.can, true, 'member').control).toBe(false)
    expect(allowance(r, viewer('inhouse', ['exportData']).can, true, 'inhouse').control).toBe(true)
    expect(allowance(r, INHOUSE.can, true, 'inhouse').control).toBe(false)
  })
  it('in the product, starts the server download and says it can take a while once it has started; nothing is built here', async () => {
    let started!: () => void
    const server = vi.fn(() => new Promise<void>(r => { started = r })), download = vi.fn(), toast = vi.fn()
    row(env({ exportDataFromServer: server, download, toast }), 'Export everything').onClick!()
    expect(server).toHaveBeenCalledOnce()
    expect(download).not.toHaveBeenCalled()
    // The check hasn't answered yet: nothing claims a download.
    await Promise.resolve()
    expect(toast).not.toHaveBeenCalled()
    started()
    await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce())
    expect(toast.mock.calls[0][0]).toBe('Your export is downloading. Big brands can take a few minutes.')
  })
  it.each([
    ['too big for one download', new AgentError('conflict', 'x', { reason: 'too_large' }), 'Your brand has too much data for one download. Ask the Inhouse team to export it for you.'],
    ['a grant that ended', new AgentError('forbidden', 'x', { reason: 'grant_required' }), "Support access has ended, so the export didn't start. Ask an admin to grant it again."],
    ['a refusal', new AgentError('forbidden', 'x'), "You can't export this brand's data."],
    ['storage down', new AgentError('unavailable', 'x'), "The export didn't start. Try again in a minute."],
    ['no connection', new AgentError('offline', 'x'), "The export didn't start. Try again in a minute."],
  ])('in the product, a check refused as %s says so plainly and never that it is downloading', async (_, err, text) => {
    const toast = vi.fn()
    row(env({ exportDataFromServer: () => Promise.reject(err), toast }), 'Export everything').onClick!()
    await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce())
    expect(toast.mock.calls[0][0]).toBe(text)
    expect(exportRefused(err)).toBe(text)
  })
  it('in the demo, downloads an invented sample in the export\'s shape and says so', () => {
    const download = vi.fn(), toast = vi.fn()
    row(env({ download, toast }), 'Export everything').onClick!()
    expect(download).toHaveBeenCalledOnce()
    const [file, text, type] = download.mock.calls[0] as [string, string, string]
    expect(file).toMatch(/^inhouse-export-\d{4}-\d{2}-\d{2}\.ndjson$/)
    expect(type).toBe('application/x-ndjson')
    const lines = text.trimEnd().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({ format: 1, kind: 'brand', sample: true })
    expect(lines.at(-1)).toMatchObject({ end: true })
    expect(toast.mock.calls[0][0]).toBe('Sample export downloaded. The demo uses invented data.')
  })
})

describe('the demo sample (property)', () => {
  const member = fc.record({
    id: fc.stringMatching(/^m_[a-z]{1,8}$/), name: fc.string({ maxLength: 20 }), email: fc.constantFrom(null, 'a@example.test'), title: fc.constantFrom(null, 'Ops'),
    role: fc.constantFrom('admin' as const, 'member' as const), status: fc.constantFrom('active' as const, 'invited' as const, 'removed' as const), photo: fc.constant(null), rev: fc.integer({ min: 1, max: 9 }),
  }) as fc.Arbitrary<MemberRecord>
  test.prop([fc.array(member, { maxLength: 8 }), fc.dictionary(fc.stringMatching(/^[a-z]{1,3}:[a-z]{1,6}$/), fc.string({ maxLength: 12 })), fc.integer({ min: 0, max: 4e12 })])(
    'a header first, an end line last, a line per kept member and setting, and counts that agree', (members, settings, at) => {
      const lines = demoExport(members, settings, at).split('\n')
      expect(lines.pop()).toBe('')
      const parsed = lines.map(l => JSON.parse(l) as { store?: string; end?: boolean; counts?: Record<string, number>; format?: number })
      expect(parsed[0].format).toBe(1)
      const end = parsed.at(-1)!
      expect(end.end).toBe(true)
      const body = parsed.slice(1, -1)
      expect(body.every(l => l.store === 'members' || l.store === 'settings')).toBe(true)
      expect(end.counts).toEqual({ members: body.filter(l => l.store === 'members').length, settings: body.filter(l => l.store === 'settings').length })
      expect(end.counts!.members).toBe(members.filter(m => m.status !== 'removed').length)
      expect(end.counts!.settings).toBe(Object.keys(settings).length)
    })
})
