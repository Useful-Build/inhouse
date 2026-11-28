// Settings, Slack notices (P5 W4, p5-w4.md section 10), as each viewer sees it, and the demo agent's save. Ways it can fail:
//  1. a Member gets an add picker, an alerts choice or a Remove button (route 75 is Admin and Inhouse only);
//  2. the picker offers a shared or non-member channel, or one already listed;
//  3. a pick saves another channel's id, or the alerts choice keeps a removed channel;
//  4. the page drops the where-alerts-go, readiness or guests rule, or names a stage (none since M2-I; the demo since A13);
//  5. the demo saves a shared or non-member channel, or a stale save.
import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { settingsPage } = await import('./content')
type Env = Parameters<typeof settingsPage>[1]
type View = Env['notify']

const noop = () => {}
const LIST: NonNullable<View['list']> = { rev: 4, channels: [{ channelId: 'C0TEST0001', name: 'ops-alerts', alerts: true }, { channelId: 'C0TEST0002', name: 'general', alerts: false }], posting: { on: false } }
const AVAILABLE = [
  { channelId: 'C0TEST0001', name: 'ops-alerts' }, { channelId: 'C0TEST0002', name: 'general' }, { channelId: 'C0TEST0005', name: 'warehouse' },
  { channelId: 'C0TEST0003', name: 'partner', disabled: 'shared_channel' as const }, { channelId: 'C0TEST0006', name: 'design', disabled: 'not_member' as const },
]
function view(over: Partial<View> = {}) {
  const calls: string[] = []
  const v: View = {
    status: 'ready', list: LIST, available: AVAILABLE, pickerError: null, pickerLoading: false, truncated: false, canEdit: true, busy: false,
    add: id => calls.push(`add:${id}`), remove: id => calls.push(`remove:${id}`), setAlerts: id => calls.push(`alerts:${id}`), retry: () => calls.push('retry'), ...over,
  }
  return { v, calls }
}
const env = (notify: View): Env => ({
  agent: agent.getSnapshot(), data: agent.read(), spent: agent.read().usage.total, phone: false,
  openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
  theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
  me: agent.me(), invite: noop, removeMember: noop, grantUi: false, product: false, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null, exportDataFromServer: null, notify,
})
const page = (v: View) => settingsPage('team-slack', env(v))
const rows = (v: View) => page(v).sections.flatMap(s => s.rows)

describe('Slack notices', () => {
  it('an Admin sees the list with Remove, a picker of open channels only, and the alerts choice', () => {
    const { v, calls } = view()
    const r = rows(v)
    expect(r.filter(x => x.title.startsWith('#')).map(x => [x.title, !!x.remove])).toEqual([['#ops-alerts', true], ['#general', true]])
    const add = r.find(x => x.title === 'Add a channel')!
    expect(add.options).toEqual(['#warehouse'])
    expect(add.desc).toContain("can't be added")
    add.save!('#warehouse')
    const alerts = r.find(x => x.title === 'Alerts channel')!
    expect([alerts.value, alerts.options]).toEqual(['#ops-alerts', ['None', '#ops-alerts', '#general']])
    alerts.save!('#general')
    alerts.save!('None')
    r.find(x => x.title === '#general')!.remove!.go()
    expect(calls).toEqual(['add:C0TEST0005', 'alerts:C0TEST0002', 'alerts:null', 'remove:C0TEST0002'])
  })

  it('a Member reads the list and the rules, and gets no control', () => {
    const { v } = view({ canEdit: false, available: null })
    const r = rows(v)
    expect(r.map(x => x.title)).toEqual(['#ops-alerts', '#general', 'For now', 'While Slack is paused', 'Who can read them'])
    expect(r.some(x => x.remove || x.kind === 'select' || x.kind === 'button')).toBe(false)
  })

  it('states where alerts go now, the readiness and guests rules, in every state', () => {
    for (const status of ['loading', 'error', 'ready'] as const) {
      const text = rows(view({ status }).v).map(x => x.desc).join(' ')
      expect(text, status).toContain("The agent's notices reach the bell in the app. Inhouse's own alerts, like a failed routine, post to your alerts channel.")
      expect(text, status).toContain('Alerts pause while Slack is paused or needs a reconnect.')
      expect(text, status).toContain('Anyone in a listed channel can read these alerts, guests included.')
    }
  })

  it('the product and the demo (no stages: M2-I, A13) say where alerts go now with no stage word, in every state', () => {
    for (const product of [true, false]) for (const status of ['loading', 'error', 'ready'] as const) {
      const p = settingsPage('team-slack', { ...env(view({ status }).v), product })
      const text = p.sections.flatMap(s => [s.label, ...s.rows.flatMap(x => [x.title, x.desc, x.value])]).join(' ')
      expect(text, status).toContain("The agent's notices reach the bell in the app. Inhouse's own alerts, like a failed routine, post to your alerts channel.")
      expect(text, status).toContain('Alerts pause while Slack is paused or needs a reconnect.')
      expect(text, status).not.toMatch(/\bstages?\b/i)
      expect(text, status).not.toMatch(/\b(Watch|Act|Run)\b/)
    }
  })

  it('says when Slack is not connected, offers a retry, and an empty list says where posts go', () => {
    const { v, calls } = view({ pickerError: 'disconnected', list: { rev: 0, channels: [], posting: { on: false } } })
    const p = page(v)
    expect(p.sections[0]!.empty).toBe('No channels yet. Your Inhouse agent posts only to channels listed here.')
    const add = p.sections.flatMap(s => s.rows).find(x => x.title === 'Add a channel')!
    expect([add.kind, add.desc]).toEqual(['button', "Slack isn't connected, or it's paused or needs a reconnect on the Tools page."])
    add.onClick!()
    expect(calls).toEqual(['retry'])
    expect(p.sections.flatMap(s => s.rows).some(x => x.title === 'Alerts channel')).toBe(false)
  })
})

describe("the demo agent's channel list", () => {
  it('saves open channels, refuses a shared or non-member one and a stale rev', async () => {
    const start = await agent.listNotifyChannels()
    const saved = await agent.saveNotifyChannels({ channelIds: ['C0DEMO0001', 'C0DEMO0002'], alertsChannelId: 'C0DEMO0001', ifRev: start.rev })
    expect(saved).toEqual({ rev: start.rev + 1, channels: [{ channelId: 'C0DEMO0001', name: 'ops-alerts', alerts: true }, { channelId: 'C0DEMO0002', name: 'warehouse', alerts: false }], posting: { on: false } })
    await expect(agent.saveNotifyChannels({ channelIds: ['C0DEMO0003'], ifRev: saved.rev })).rejects.toMatchObject({ code: 'conflict', reason: 'shared_channel' })
    await expect(agent.saveNotifyChannels({ channelIds: ['C0DEMO0004'], ifRev: saved.rev })).rejects.toMatchObject({ code: 'conflict', reason: 'not_member' })
    await expect(agent.saveNotifyChannels({ channelIds: [], ifRev: start.rev })).rejects.toMatchObject({ code: 'conflict', current: { rev: saved.rev } })
    expect(await agent.listNotifyChannels()).toEqual(saved)
  })
})

describe('Slack notices only with Slack connected (CI round)', async () => {
  const { SECTIONS, hasSlack, menuFor } = await import('./menu')
  const tabs = (m: typeof SECTIONS) => m.flatMap(s => s.pages.map(p => p.id))
  const none = { connected: ['shopify'], channels: [] }
  it('a brand without Slack gets no menu row and no page; with it as a tool or a channel, both show', () => {
    expect(hasSlack(none)).toBe(false)
    expect(tabs(menuFor(none))).not.toContain('team-slack')
    // The demo's menu (`menuFor` without `product`): every page but Slack notices and the product-only What the agent can
    // do (Stage 1 M3-C).
    expect(tabs(menuFor(none))).toEqual(tabs(SECTIONS).filter(id => id !== 'team-slack' && id !== 'team-ceiling'))
    for (const t of [{ connected: ['slack'], channels: [] }, { connected: [], channels: [{ key: 'slack' }] }]) {
      expect(hasSlack(t)).toBe(true)
      expect(tabs(menuFor(t))).toContain('team-slack')
    }
    const e = env(view().v)
    const noSlack = { ...e, data: { ...e.data, tools: { ...e.data.tools, connected: ['shopify'], channels: [] } } }
    const p = settingsPage('team-slack', noSlack)
    expect(p.title).not.toBe('Slack notices')
    expect(JSON.stringify(p)).not.toContain('Slack')
    expect(settingsPage('team-slack', e).title).toBe('Slack notices')
  })
})
