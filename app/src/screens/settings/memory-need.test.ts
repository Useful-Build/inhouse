// P6a: memory is open at Watch. Ways it can fail, written first: a memory row still needs Act (locked at Watch), a
// memory row went missing (so the check passes on nothing), the Forget rows are empty, or the change opened some other
// row too (the literal list below is every row that still needs Act or Run).
import { expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { settingsPage } = await import('./content')
const { SETTINGS_PAGES } = await import('./menu')
type Env = Parameters<typeof settingsPage>[1]

function rows() {
  const data = agent.read()
  const noop = () => {}
  const notify: Env['notify'] = { status: 'idle', list: null, available: null, pickerError: null, pickerLoading: false, truncated: false, canEdit: false, busy: false, add: noop, remove: noop, setAlerts: noop, retry: noop }
  const env: Env = {
    S: 2, stage: 'Run', agent: agent.getSnapshot(), data, spent: data.usage.total, phone: false,
    openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
    theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
    me: agent.me(), invite: noop, removeMember: noop, grantUi: false, product: false, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null, exportDataFromServer: null, notify,
  }
  return SETTINGS_PAGES.flatMap(p => settingsPage(p.id, env).sections.flatMap(s => s.rows))
}

it('the five memory rows need no stage', () => {
  const all = rows()
  const named = ['m:learn', 'm:ask'].map(k => all.find(r => r.key === k))
  const titled = ['Teach it something', 'Team memory'].map(t => all.find(r => r.title === t))
  for (const r of [...named, ...titled]) { expect(r).toBeDefined(); expect(r!.need, r!.title).toBe(0) }
  const forget = all.filter(r => r.kind === 'button' && r.value === 'Forget')
  expect(forget.length, 'the Forget rows exist').toBeGreaterThan(0)
  for (const r of forget) expect(r.need, r.title).toBe(0)
})

it('exactly these rows still need Act or Run', () => {
  const needing = rows().filter(r => r.need > 0).map(r => `${r.need}:${r.key ?? r.title}`)
  expect(needing).toMatchInlineSnapshot(`
    [
      "1:n:wait",
      "1:n:channel",
      "1:n:slack",
      "1:n:weekly",
      "1:a:0",
      "1:a:1",
      "1:a:2",
      "1:a:3",
      "2:l:returns",
      "2:l:chase",
      "2:l:nudge",
      "2:l:pause",
      "2:l:daily",
      "2:l:restock",
      "1:Pause Inhouse agent",
    ]
  `)
})
