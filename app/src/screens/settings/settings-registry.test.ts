// The settings registry (app/shared/contract/settings.ts) against the settings page that saves into it. Ways it can
// fail, written down first:
//  1. a key the page saves has no spec, so the product refuses a save the demo makes;
//  2. a role (`p:`) or grant (`d:support`) key the page saves is a setting, so a privilege could be written through the
//     settings routes;
//  3. an option or default the page offers doesn't parse, so a saved choice fails the contract;
//  4. the money field's saved text (checkField) doesn't parse.
// It lives beside the page, not the contract: the contract folder typechecks under the Worker configs, which can't load the app.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it, vi } from 'vitest'
import { settingSpec } from '../../../shared/contract/settings'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
// The app's agent (the demo one here): loading it also sets the clock the page reads.
const { agent } = await import('../../agent')
const { MENU, checkField, settingsPage } = await import('./content')
type Env = Parameters<typeof settingsPage>[1]
type Row = ReturnType<typeof settingsPage>['sections'][number]['rows'][number]

/** Every row on every settings page, at Run (the stage that shows them all). */
function allRows(): Row[] {
  const data = agent.read()
  const noop = () => {}
  const env: Env = {
    S: 2, stage: 'Run', agent: agent.getSnapshot(), data, spent: data.usage.total, phone: false,
    openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
    theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
  }
  return MENU.flatMap(g => g.items).flatMap(([tab]) => settingsPage(tab, env).sections.flatMap(s => s.rows))
}
const rows = allRows()
/** Never settings: a role, a grant. */
const refused = (key: string) => key.startsWith('p:') || key === 'd:support'
const parses = (key: string, v: unknown) => settingSpec(key)!.value.safeParse(v).success

describe('the page and the registry (failures 1 to 3)', () => {
  const keys = new Set(rows.flatMap(r => [r.key, r.switchKey]).filter((k): k is string => !!k))

  it('sees every kind of key, so the checks below are not empty', () => {
    for (const k of ['g:name', 'g:tz', 'n:slack', 'tm:fable:effort', 'tm:fable:on', 'l:returns', 'l:daily', 'a:0', 'd:2fa', 'd:support', 'p:m_sam']) expect(keys).toContain(k)
  })

  it('has a spec for every key the page saves, and none for a role or a grant', () => {
    for (const k of keys) expect(settingSpec(k) === null, k).toBe(refused(k))
  })

  it('parses every option, default and switch value the page offers', () => {
    for (const r of rows) {
      if (r.switchKey) for (const v of ['off', 'on']) expect(parses(r.switchKey, v), `${r.switchKey} ${v}`).toBe(true)
      if (!r.key || refused(r.key)) continue
      if (r.kind === 'toggle') for (const v of [true, false]) expect(parses(r.key, v), `${r.key} ${v}`).toBe(true)
      if (r.kind === 'select' || r.kind === 'mode') for (const o of r.options ?? []) expect(parses(r.key, o), `${r.key} ${o}`).toBe(true)
      if (r.kind === 'select' || r.kind === 'mode' || r.kind === 'text') expect(parses(r.key, r.value), `${r.key} ${r.value}`).toBe(true)
    }
  })

  it('never saves a role, a photo or the support switch as a setting: those rows run on their own calls', () => {
    const support = rows.find(r => r.key === 'd:support')!
    expect(support.kind).toBe('toggle')
    expect(typeof support.toggle, 'flipping it grants or ends access, never setToggle').toBe('function')
    const roles = rows.filter(r => r.key?.startsWith('p:'))
    expect(roles.length).toBeGreaterThan(0)
    for (const r of roles) expect(typeof r.save, `${r.key} saves through setMemberRole`).toBe('function')
    const saved = agent.getSnapshot()
    for (const k of [...Object.keys(saved.settings), ...Object.keys(saved.toggles)]) expect(refused(k), `${k} was saved`).toBe(false)
  })

  it('puts each key in the scope section 6 names', () => {
    const scope = (k: string) => settingSpec(k)?.scope
    expect(['g:name', 'g:theme', 'n:channel', 'm:learn'].map(scope)).toEqual(['personal', 'personal', 'personal', 'personal'])
    expect(['g:tz', 'm:ask', 's:cap', 'a:3'].map(scope)).toEqual(['brand', 'brand', 'brand', 'brand'])
    expect(['stage', 't:signs', 'g:mode', 'tm:x:on', 'l:x', 'd:chats'].map(scope)).toEqual(['technical', 'technical', 'technical', 'technical', 'technical', 'technical'])
    expect(['g:name', 't:signs'].map(k => settingSpec(k)!.auditSafe)).toEqual([false, false])
  })

  it('redacts the free-text choices, and still takes every option the page offers for them', () => {
    // `n:channel` (alert channels) and `g:mode` (model modes) are free text until the server holds closed lists.
    for (const key of ['n:channel', 'g:mode']) {
      expect(settingSpec(key)!.auditSafe, key).toBe(false)
      const row = rows.find(r => r.key === key)
      expect(row?.options?.length, key).toBeGreaterThan(0)
      for (const o of [...row!.options!, row!.value]) expect(parses(key, o), `${key} ${o}`).toBe(true)
      expect(parses(key, ''), `${key} empty`).toBe(false)
      expect(parses(key, 'x'.repeat(81)), `${key} too long`).toBe(false)
    }
  })
})

describe('the money field (failure 4)', () => {
  test.prop([fc.integer({ min: 1, max: 10_000_000 })])('what checkField saves parses', cents => {
    const r = checkField('money', (cents / 100).toFixed(2))
    expect('value' in r && parses('s:cap', r.value)).toBe(true)
  })
})
