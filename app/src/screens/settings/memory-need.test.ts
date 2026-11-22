// P6a: memory is open at Watch. Ways it can fail, written first: a memory row still needs Act (locked at Watch), or
// the change opened some other row too.
import { expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { MENU, settingsPage } = await import('./content')
type Env = Parameters<typeof settingsPage>[1]

function rowsAt(S: 0 | 1 | 2) {
  const data = agent.read()
  const noop = () => {}
  const env: Env = {
    S, stage: ['Watch', 'Act', 'Run'][S] as Env['stage'], agent: agent.getSnapshot(), data, spent: data.usage.total, phone: false,
    openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
    theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
    me: agent.me(), invite: noop, removeMember: noop, grantUi: false, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null,
  }
  return MENU.flatMap(g => g.items).flatMap(([tab]) => settingsPage(tab, env).sections.flatMap(s => s.rows))
}

it('the memory rows need no stage; the rows that still need Act or Run are not memory rows', () => {
  const rows = rowsAt(2)
  const memory = rows.filter(r => r.key === 'm:learn' || r.key === 'm:ask' || r.title === 'Teach it something' || r.title === 'Team memory' || (r.kind === 'button' && r.value === 'Forget'))
  expect(memory.map(r => r.key ?? r.title).sort()).toContain('m:learn')
  expect(memory.length).toBeGreaterThanOrEqual(4)
  for (const r of memory) expect(r.need, r.title).toBe(0)
  expect(rows.filter(r => r.need > 0).length, 'other rows keep their stage').toBeGreaterThan(0)
  expect(rows.filter(r => r.need > 0 && memory.includes(r))).toEqual([])
})
