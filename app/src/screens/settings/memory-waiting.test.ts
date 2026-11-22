// P6a W2: the Team memory page's waiting facts. Ways it can fail, written first: the section shows for someone without
// `approveMemory`, or with nothing waiting (an empty section); it sits below the team's rules instead of above; a row
// loses its fact's text, who saved it or when; Approve or Reject runs the other decision or the wrong fact; a fact's text
// is read as anything but plain text; the demo (no waiting facts) changes.
import { expect, it, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { settingsPage } = await import('./content')
type Env = Parameters<typeof settingsPage>[1]

const at = { iso: '2026-11-20T10:00:00.000Z', ms: Date.UTC(2026, 10, 20, 10) }
const fact = (key: string, text: string) => ({ key, text, source: 'Priya told your Inhouse agent in a chat', at, rev: 2, scope: 'brand' as const, waiting: true as const, kind: 'memory' as const })
const WAITING = [fact('mem_one', 'Kestrel wants PDFs'), fact('mem_two', '**Ship** [heavy](https://example.test) orders by courier')]

function page(o: Partial<Env> = {}, approve = true) {
  const data = agent.read()
  const noop = () => {}
  const me = agent.me()
  const env: Env = {
    S: 0, stage: 'Watch', agent: agent.getSnapshot(), data, spent: data.usage.total, phone: false,
    openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
    theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
    me: me && { ...me, can: { ...me.can, approveMemory: approve } }, invite: noop, removeMember: noop, grantUi: false, showGrant: true,
    loadingMore: false, loadMore: noop, exportFromServer: null, ...o,
  }
  return settingsPage('team-memory', env)
}

it('an approver sees "Waiting for your OK" first, one row per fact with its text, who and when, Approve and Reject', () => {
  const decided: [string, boolean][] = []
  const p = page({ waiting: WAITING, review: (key, approved) => { decided.push([key, approved]) } })
  expect(p.sections[0].label).toBe('Waiting for your OK')
  const rows = p.sections[0].rows
  expect(rows.map(r => [r.title, r.kind, r.value, r.need, r.can])).toEqual([
    ['Kestrel wants PDFs', 'button', 'Approve', 0, 'approveMemory'],
    ['**Ship** [heavy](https://example.test) orders by courier', 'button', 'Approve', 0, 'approveMemory'],
  ])
  expect(rows[0].desc).toMatch(/^Priya told your Inhouse agent in a chat, /)
  expect(rows.map(r => r.also?.label)).toEqual(['Reject', 'Reject'])
  rows[1].onClick!()
  rows[0].also!.go()
  expect(decided).toEqual([['mem_two', true], ['mem_one', false]])
  // The team's own rules and the switches follow.
  expect(p.sections.at(-1)?.label).toBe('How your Inhouse agent learns')
})

it('no section with nothing waiting, for someone without approveMemory, or before the list is read', () => {
  const labels = (p: ReturnType<typeof page>) => p.sections.map(s => s.label)
  expect(labels(page({ waiting: [], review: () => {} }))).not.toContain('Waiting for your OK')
  expect(labels(page({ waiting: WAITING, review: () => {} }, false))).not.toContain('Waiting for your OK')
  expect(labels(page())).not.toContain('Waiting for your OK')
})

it('the demo page is as before: no waiting section, and the sections are the team groups then the switches', () => {
  expect(page().sections.map(s => s.label)).toEqual([...agent.read().memory.team.map(g => g.group), 'How your Inhouse agent learns'])
})
