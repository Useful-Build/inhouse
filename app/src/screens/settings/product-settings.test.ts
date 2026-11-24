// What the product's Settings leaves out, what both builds keep, and where Pause and the brand name live. Ways it can fail,
// written first:
//  1. the product shows a setting nothing reads (Language, Text size, Two-step sign-in, Tone, Signs emails as) or an Act-stage
//     alert nothing sends (the Notifications rows), or the demo loses one of them;
//  2. the product menu, the palette or a deep link still offers Who approves what, Run limits or Notifications, or the demo
//     loses a page;
//  3. the limits section keeps its "Approvals and limits" name in the product with only the Spending cap left in it;
//  4. Pause Inhouse agent is missing from the page that keeps the Spending cap (nothing else in the product can pause at
//     Act or Run), or still sits on Run limits;
//  5. the Brand name row is missing, writes under another key, or the delete request reads "for ." with no name, or the demo's
//     sidebar ignores a saved Brand name (the product reads it from `b:name`, the demo must too);
//  6. a product deep link to a page the product leaves out renders that page for a frame before the redirect;
//  7. a Member sees an enabled Pause button the server refuses (POST /api/pause and /api/resume: Admin and Inhouse team only).
import { describe, expect, it, vi } from 'vitest'
import type { Can } from '../../agent/types'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { settingsPage } = await import('./content')
const { SECTIONS, SETTINGS_PAGES, menuFor, pageShown, settingsTabs } = await import('./menu')
const { settingRow } = await import('../../../shared/contract/settings-table')
const { allowance } = await import('./allowance')
const { mayPause } = await import('../../lib/product-flow')
const { CAN_KEYS } = await import('../../../shared/contract/keys')
type Env = Parameters<typeof settingsPage>[1]

const noop = () => {}
const env = (product: boolean, over: Partial<Env> = {}): Env => ({
  S: 2, stage: 'Run', agent: agent.getSnapshot(), data: agent.read(), spent: agent.read().usage.total, phone: false,
  openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
  theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
  me: agent.me(), invite: noop, removeMember: noop, grantUi: product, product, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null, exportDataFromServer: null,
  notify: { status: 'idle', list: null, available: null, pickerError: null, pickerLoading: false, truncated: false, canEdit: false, busy: false, add: noop, remove: noop, setAlerts: noop, retry: noop },
  ...over,
})
const rows = (tab: string, e: Env) => settingsPage(tab, e).sections.flatMap(s => s.rows)
const titles = (tab: string, e: Env) => rows(tab, e).map(r => r.title)
const noTools = { connected: [], channels: [] }

describe('rows only the demo shows (failure 1)', () => {
  const cases: [string, string[]][] = [
    ['you-general', ['Language', 'Text size']],
    ['you-notif', ['Approvals waiting', 'Send alerts to', 'Weekly report']],
    ['team-agent', ['Tone', 'Signs emails as']],
    ['team-data', ['Two-step sign-in']],
  ]
  for (const [tab, hidden] of cases) {
    it(`${tab}: the product leaves out ${hidden.join(', ')}; the demo keeps them`, () => {
      for (const t of hidden) {
        expect(titles(tab, env(true)), `product ${t}`).not.toContain(t)
        expect(titles(tab, env(false)), `demo ${t}`).toContain(t)
      }
    })
  }
  it('the product keeps the rest of each page, and the chat-app switch goes with the alerts', () => {
    expect(titles('you-general', env(true))).toEqual(expect.arrayContaining(['Photo', 'Name', 'Email', 'Role', 'Theme', 'Time zone']))
    expect(titles('team-data', env(true))).toEqual(expect.arrayContaining(['Inhouse team access', 'Your team', 'Export everything']))
    // The Notifications page is not in the product: a link to it renders the default page, never its rows.
    expect(titles('you-notif', env(true))).toEqual(titles('you-general', env(true)))
    expect(rows('you-notif', env(true)).some(r => r.key === 'n:slack')).toBe(false)
    expect(rows('you-notif', env(false)).some(r => r.key === 'n:slack')).toBe(true)
  })
})

describe('the menu, the palette and the deep links (failures 2 and 3)', () => {
  const ids = (product: boolean) => menuFor(noTools, product).flatMap(s => s.pages).map(p => p.id)
  it('the product has no Who approves what, Run limits or Notifications; the demo has every page', () => {
    for (const id of ['team-approvals', 'team-limits', 'you-notif']) {
      expect(ids(true), id).not.toContain(id)
      expect(settingsTabs(true), id).not.toContain(id)
      expect(pageShown(id, true), id).toBe(false)
      expect(ids(false), id).toContain(id)
      expect(settingsTabs(false), id).toContain(id)
    }
    expect(settingsTabs(false)).toEqual(SETTINGS_PAGES.map(p => p.id))
    expect(ids(true)).toEqual(expect.arrayContaining(['you-general', 'you-memory', 'team-agent', 'team-modes', 'team-memory', 'team-spend', 'team-members', 'team-plan', 'team-data', 'team-audit']))
  })
  it('the section that holds the Spending cap is called Spending in the product, and keeps its name in the demo', () => {
    const limits = (product: boolean) => menuFor(noTools, product).find(s => s.id === 'limits')!
    expect(limits(true).label).toBe('Spending')
    expect(limits(true).pages.map(p => p.id)).toEqual(['team-spend'])
    expect(limits(false).label).toBe('Approvals and limits')
    expect(limits(false).pages.map(p => p.id)).toEqual(['team-approvals', 'team-limits', 'team-spend'])
    expect(SECTIONS.find(s => s.id === 'limits')!.label).toBe('Approvals and limits')
  })
  it('Slack notices still shows only with Slack, in both builds', () => {
    for (const product of [true, false]) {
      expect(ids(product)).not.toContain('team-slack')
      expect(menuFor({ connected: ['slack'], channels: [] }, product).flatMap(s => s.pages).map(p => p.id)).toContain('team-slack')
    }
  })
})

describe('Pause Inhouse agent (failure 4)', () => {
  it('is on the Spending cap page in both builds, and no longer on Run limits', () => {
    for (const product of [true, false]) {
      const pause = rows('team-spend', env(product)).find(r => r.title === 'Pause Inhouse agent')
      expect(pause, `spending cap, product ${product}`).toBeDefined()
      expect(pause!.kind).toBe('button')
      expect(pause!.need).toBe(1)
      expect(titles('team-limits', env(product))).not.toContain('Pause Inhouse agent')
    }
  })
  it('does what the old row did: Pause or Resume at once', () => {
    let toggled = 0
    const pause = rows('team-spend', env(true, { togglePause: () => { toggled++ } })).find(r => r.title === 'Pause Inhouse agent')!
    pause.onClick!()
    expect(toggled).toBe(1)
    expect(pause.value).toBe('Pause Inhouse agent')
    const paused = rows('team-spend', env(true, { agent: { ...agent.getSnapshot(), paused: { iso: '2026-11-16T12:00:00.000Z', ms: Date.parse('2026-11-16T12:00:00Z') } } })).find(r => r.title === 'Pause Inhouse agent')!
    expect(paused.value).toBe('Resume Inhouse agent')
  })
})

describe('a page the product leaves out (failure 6)', () => {
  it('a hidden page renders the default page in the product, and itself in the demo', () => {
    for (const id of ['team-approvals', 'team-limits', 'you-notif']) {
      expect(settingsPage(id, env(true)).title, id).toBe(settingsPage('you-general', env(true)).title)
      expect(settingsPage(id, env(false)).title, id).not.toBe(settingsPage('you-general', env(false)).title)
    }
  })
})

describe('Pause row permissions (failure 7)', () => {
  const canOf = (on: string[]) => Object.fromEntries(CAN_KEYS.map(k => [k, on.includes(k)])) as Can
  it('shows for the roles the server lets pause (Admin, Inhouse team) and not for a Member; the demo allows it', () => {
    const pause = rows('team-spend', env(true)).find(r => r.title === 'Pause Inhouse agent')!
    // `editBrandSettings` is the can key with the same class and allow list as pause and resume (access-matrix rows 10, 36, 37;
    // server/auth/pause-can.test.ts fails if they drift).
    expect(pause.can).toBe('editBrandSettings')
    expect(allowance(pause, canOf(['editBrandSettings']), true, 'admin').control).toBe(true)
    expect(allowance(pause, canOf(['editBrandSettings']), true, 'inhouse').control).toBe(true)
    expect(allowance(pause, canOf(['invite']), true, 'member').control).toBe(false)
    expect(allowance(pause, canOf([]), true, 'member').control).toBe(false)
    expect(allowance(pause, undefined, false).control).toBe(true)
  })
  it("the top bar's Pause and Resume button follows the same key: Admin and Inhouse yes, a Member and an unknown person in the product no", () => {
    expect(mayPause(canOf(['editBrandSettings']), true)).toBe(true)
    expect(mayPause(canOf([]), true)).toBe(false)
    expect(mayPause(undefined, true)).toBe(false)
    expect(mayPause(undefined, false)).toBe(true)
  })
})

describe('Brand name (failure 5)', () => {
  it('the demo shows a saved Brand name in the sidebar data (trimmed), and the sample name when none or blank', async () => {
    const sample = agent.read().meta.brand.name
    await agent.setSetting('b:name', '  Trailhead Supply  ')
    expect(agent.read().meta.brand.name).toBe('Trailhead Supply')
    await agent.setSetting('b:name', null)
    expect(agent.read().meta.brand.name).toBe(sample)
  })
  it('is an Admin-editable brand setting on the Inhouse agent page, in both builds', () => {
    for (const product of [true, false]) {
      const row = rows('team-agent', env(product)).find(r => r.title === 'Brand name')!
      expect(row, `product ${product}`).toBeDefined()
      expect(row.key).toBe('b:name')
      expect(row.kind).toBe('text')
      expect(settingRow('b:name')).toMatchObject({ scope: 'brand', rule: { t: 'text', min: 1, max: 80 }, auditSafe: false })
    }
  })
  it("shows the brand's name, and the delete request names it", () => {
    const e = env(false)
    const name = e.data.meta.brand.name
    expect(name).not.toBe('')
    expect(rows('team-agent', e).find(r => r.title === 'Brand name')!.value).toBe(name)
    const calls: string[] = []
    rows('team-data', { ...e, openTeam: (_t, text) => { calls.push(text ?? '') } }).find(r => r.title === 'Delete Inhouse agent and its data')!.onClick!()
    expect(calls).toEqual([`Please delete the Inhouse agent and its data for ${name}.`])
  })
  it('a saved name wins, and with no name the request reads without one (never "for .")', () => {
    const delRequest = (e: Env) => {
      const calls: string[] = []
      rows('team-data', { ...e, openTeam: (_t, text) => { calls.push(text ?? '') } }).find(r => r.title === 'Delete Inhouse agent and its data')!.onClick!()
      return calls[0]
    }
    const base = env(true)
    const named = { ...base, agent: { ...base.agent, settings: { ...base.agent.settings, 'b:name': 'Trailhead Supply' } } }
    expect(delRequest(named)).toBe('Please delete the Inhouse agent and its data for Trailhead Supply.')
    const none = { ...base, data: { ...base.data, meta: { ...base.data.meta, brand: { ...base.data.meta.brand, name: '' } } } }
    expect(delRequest(none)).toBe('Please delete the Inhouse agent and its data.')
  })
})
