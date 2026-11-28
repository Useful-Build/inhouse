// What the product's Settings leaves out, what both builds keep, and where Pause and the brand name live. Ways it can fail,
// written first:
//  1. the product shows a setting nothing reads (Language, Text size, Two-step sign-in, Tone, Signs emails as), or the
//     demo loses one of them;
//  2. a menu, the palette or a deep link still offers Who approves what, Run limits, Notifications or Stage and plan (gone
//     from the product with M2-I and from the demo with decision A13, option B), or the demo loses a product page;
//  3. the limits section keeps its "Approvals and limits" name with only the Spending cap left in it;
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
const { SECTIONS, SETTINGS_PAGES, TEAM_SETTINGS_TAB, menuFor, pageShown, settingsTabs } = await import('./menu')
const { settingRow } = await import('../../../shared/contract/settings-table')
const { allowance } = await import('./allowance')
const { mayPause } = await import('../../lib/product-flow')
const { CAN_KEYS } = await import('../../../shared/contract/keys')
type Env = Parameters<typeof settingsPage>[1]

const noop = () => {}
const env = (product: boolean, over: Partial<Env> = {}): Env => ({
  agent: agent.getSnapshot(), data: agent.read(), spent: agent.read().usage.total, phone: false,
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
  it('the product keeps the rest of each page; no build has the Notifications page or its chat-app switch', () => {
    expect(titles('you-general', env(true))).toEqual(expect.arrayContaining(['Photo', 'Name', 'Email', 'Role', 'Theme', 'Time zone']))
    expect(titles('team-data', env(true))).toEqual(expect.arrayContaining(['Inhouse team access', 'Your team', 'Export everything']))
    // A link to the Notifications page renders the default page, never its rows.
    for (const product of [true, false]) {
      expect(titles('you-notif', env(product))).toEqual(titles('you-general', env(product)))
      expect(rows('you-notif', env(product)).some(r => r.key === 'n:slack')).toBe(false)
    }
  })
})

describe('the menu, the palette and the deep links (failures 2 and 3)', () => {
  const ids = (product: boolean) => menuFor(noTools, product).flatMap(s => s.pages).map(p => p.id)
  it('no build has Who approves what, Run limits, Notifications or Stage and plan (M2-I; the demo since A13)', () => {
    for (const id of ['team-approvals', 'team-limits', 'you-notif', 'team-plan']) {
      for (const product of [true, false]) {
        expect(ids(product), id).not.toContain(id)
        expect(settingsTabs(product), id).not.toContain(id)
      }
    }
    // The demo has every page the product has but What the agent can do (M3-C: the demo has no ceiling yet).
    expect(settingsTabs(true)).toEqual(SETTINGS_PAGES.map(p => p.id))
    expect(settingsTabs(false)).toEqual(SETTINGS_PAGES.map(p => p.id).filter(id => id !== 'team-ceiling'))
    expect(ids(true)).toEqual(expect.arrayContaining(['you-general', 'you-memory', 'you-permissions', 'team-agent', 'team-modes', 'team-memory', 'team-spend', 'team-members', 'team-data', 'team-audit']))
  })
  // Stage 1 M2-I: the product has no stages. Its Env is the Act view it is pinned to (store.ts `useCtx`). The audit log is
  // history: a line written before the retirement keeps its words (N17), so it isn't read here.
  it('no Settings page, title or section names a stage, in the product or the demo (A13)', () => {
    const slack = { connected: ['slack'], channels: [] }
    for (const product of [true, false]) for (const sec of menuFor(slack, product)) {
      expect(sec.label, sec.id).not.toMatch(/\bstages?\b/i)
      for (const { id, label } of sec.pages.filter(p => p.id !== 'team-audit')) {
        const page = settingsPage(id, env(product))
        const text = [label, page.title, ...page.sections.flatMap(x => [x.label, x.empty ?? '', ...x.rows.flatMap(r => [r.title, r.desc, r.value, ...(r.options ?? [])])])].join(' | ')
        expect(text, id).not.toMatch(/\bstages?\b/i)
        expect(text, id).not.toMatch(/\b(Watch|Act|Run)\b/)
        expect(page.sections.flatMap(x => x.rows).filter(r => r.need > 1).map(r => r.title), id).toEqual([])
      }
    }
  })
  it("the account menu's Team settings opens a page each build has (no Stage and plan)", () => {
    expect(TEAM_SETTINGS_TAB).toBe('team-agent')
    for (const product of [true, false]) expect(settingsTabs(product)).toContain(TEAM_SETTINGS_TAB)
  })
  it('Always allowed is in both builds (Stage 1 M2-H; the demo since its sample permissions)', () => {
    for (const product of [true, false]) {
      expect(ids(product)).toContain('you-permissions')
      expect(settingsTabs(product)).toContain('you-permissions')
      expect(pageShown('you-permissions', product)).toBe(true)
    }
  })
  it("the Inhouse team's product menu has no Always allowed (they have no permissions); every other page stays", () => {
    const inhouse = menuFor(noTools, true, 'inhouse').flatMap(s => s.pages).map(p => p.id)
    expect(inhouse).toEqual(ids(true).filter(id => id !== 'you-permissions'))
  })
  it('the section that holds the Spending cap is called Spending, in both builds', () => {
    for (const product of [true, false]) {
      const limits = menuFor(noTools, product).find(s => s.id === 'limits')!
      expect(limits.label).toBe('Spending')
      expect(limits.pages.map(p => p.id)).toEqual(['team-spend'])
    }
    expect(SECTIONS.find(s => s.id === 'limits')!.label).toBe('Spending')
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

describe('a page no build has (failure 6)', () => {
  it('a gone page renders the default page, in the product and the demo; the ceiling page only in the product', () => {
    for (const product of [true, false]) {
      for (const id of ['team-approvals', 'team-limits', 'you-notif', 'team-plan']) {
        expect(settingsPage(id, env(product)).title, id).toBe(settingsPage('you-general', env(product)).title)
      }
    }
    expect(settingsPage('team-ceiling', env(true)).title).toBe('What the agent can do')
    expect(settingsPage('team-ceiling', env(false)).title).toBe(settingsPage('you-general', env(false)).title)
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
