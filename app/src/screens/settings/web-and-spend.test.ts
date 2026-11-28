// M1-F: the web switches and the two spend fields on the Settings pages. Ways it can fail, written first:
//  1. a web switch saves under another key, or with the wrong default (web search must start off, reading pages on);
//  2. an Admin can't flip a web switch, a Member can, or an Admin gets a control over which websites it may open (only
//     the Inhouse team widens what the agent can reach);
//  3. the Job budget field saves a value the server refuses (under the $0.25 start hold, over the $100 ceiling), or
//     refuses one it takes; its default isn't $25;
//  4. the Monthly cap is shown twice, or the Job budget sits on another page than the Monthly cap;
//  5. a Member gets a control on either spend field.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it, vi } from 'vitest'
import type { Can } from '../../agent/types'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
const { agent } = await import('../../agent')
const { checkField, settingsPage } = await import('./content')
const { allowance } = await import('./allowance')
const { settingSpec } = await import('../../../shared/contract/settings')
const { CAN_KEYS } = await import('../../../shared/contract/keys')
type Env = Parameters<typeof settingsPage>[1]

const noop = () => {}
const env = (product: boolean): Env => ({
  agent: agent.getSnapshot(), data: agent.read(), spent: agent.read().usage.total, phone: false,
  openTeam: noop, openPop: noop, openSettings: noop, newChat: noop, goSkills: noop, togglePause: noop,
  theme: 'system', setTheme: noop, toast: noop, forget: noop, download: noop, setRole: noop, setSupport: noop,
  me: agent.me(), invite: noop, removeMember: noop, grantUi: product, product, showGrant: true, loadingMore: false, loadMore: noop, exportFromServer: null, exportDataFromServer: null,
  notify: { status: 'idle', list: null, available: null, pickerError: null, pickerLoading: false, truncated: false, canEdit: false, busy: false, add: noop, remove: noop, setAlerts: noop, retry: noop },
})
const rows = (tab: string, product: boolean) => settingsPage(tab, env(product)).sections.flatMap(s => s.rows)
const canOf = (on: readonly string[]): Can => Object.fromEntries(CAN_KEYS.map(k => [k, on.includes(k)])) as Can
/** What `me().can` says for each role (server/auth: an Admin edits brand settings, never technical ones). */
const ADMIN = canOf(['editBrandSettings', 'switchModel', 'invite'])
const MEMBER = canOf([])
const INHOUSE = canOf(['editBrandSettings', 'editTechnical', 'switchModel'])
const parses = (key: string, v: unknown) => settingSpec(key)!.value.safeParse(v).success

describe('the web switches (failures 1 and 2)', () => {
  for (const product of [true, false]) {
    it(`sit on the Inhouse agent page with their keys and defaults (${product ? 'product' : 'demo'})`, () => {
      const r = rows('team-agent', product)
      const search = r.find(x => x.title === 'Search the web')!
      const read = r.find(x => x.title === 'Read web pages')!
      expect([search.kind, search.key, search.def]).toEqual(['toggle', 't:websearch', false])
      expect([read.kind, read.key, read.def]).toEqual(['toggle', 't:webfetch_on', true])
      for (const k of ['t:websearch', 't:webfetch_on']) {
        expect(settingSpec(k)!.scope, k).toBe('brand')
        for (const v of [true, false]) expect(parses(k, v), `${k} ${v}`).toBe(true)
        for (const v of ['on', 1, 'true']) expect(parses(k, v), `${k} ${String(v)}`).toBe(false)
      }
    })
  }
  it('an Admin and the Inhouse team flip both, a Member neither; only the Inhouse team edits the website list', () => {
    const r = rows('team-agent', true)
    const control = (title: string, can: Can) => allowance(r.find(x => x.title === title)!, can, true).control
    for (const title of ['Search the web', 'Read web pages']) {
      expect(control(title, ADMIN), `admin ${title}`).toBe(true)
      expect(control(title, INHOUSE), `inhouse ${title}`).toBe(true)
      expect(control(title, MEMBER), `member ${title}`).toBe(false)
    }
    expect(control('Websites it may open', ADMIN)).toBe(false)
    expect(control('Websites it may open', MEMBER)).toBe(false)
    expect(control('Websites it may open', INHOUSE)).toBe(true)
  })
})

describe('the spend fields (failures 3 to 5)', () => {
  it('the Spending cap page holds one Monthly cap and the Job budget, $25 by default; no other page has either', () => {
    for (const product of [true, false]) {
      const r = rows('team-spend', product)
      expect(r.filter(x => x.key === 's:cap').map(x => [x.title, x.type])).toEqual([['Monthly cap', 'money']])
      const job = r.filter(x => x.key === 's:job_cap')
      expect(job.map(x => [x.title, x.kind, x.type, x.defaultValue])).toEqual([['Job budget', 'text', 'jobBudget', '$25']])
      expect(job[0].desc).not.toMatch(/[–—]/)
      for (const tab of ['team-agent', 'team-data', 'you-general']) expect(rows(tab, product).some(x => x.key === 's:cap' || x.key === 's:job_cap'), tab).toBe(false)
    }
  })
  it('an Admin and the Inhouse team change both, a Member neither', () => {
    const r = rows('team-spend', true)
    for (const key of ['s:cap', 's:job_cap']) {
      const row = r.find(x => x.key === key)!
      expect(allowance(row, ADMIN, true).control, key).toBe(true)
      expect(allowance(row, INHOUSE, true).control, key).toBe(true)
      expect(allowance(row, MEMBER, true).control, key).toBe(false)
    }
  })
  test.prop([fc.integer({ min: 1, max: 20_000 })])('the Job budget saves exactly what the server takes: $0.25 to $100', cents => {
    const r = checkField('jobBudget', (cents / 100).toFixed(2))
    const inRange = cents >= 25 && cents <= 10_000
    expect('value' in r, String(cents)).toBe(inRange)
    if ('value' in r) expect(parses('s:job_cap', r.value)).toBe(true)
    else expect(r.error).toBe('Enter an amount from $0.25 to $100.')
    // The server's own rule agrees on the same amount, in the field's saved form.
    expect(parses('s:job_cap', `$${cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2)}`)).toBe(inRange)
  })
  it('the edges and the typed forms', () => {
    expect(checkField('jobBudget', '$100')).toEqual({ value: '$100' })
    expect(checkField('jobBudget', '0.25')).toEqual({ value: '$0.25' })
    expect(checkField('jobBudget', '25')).toEqual({ value: '$25' })
    for (const bad of ['$100.01', '$0.24', '$0', '1e2', '-5', '', '$1,000']) expect('error' in checkField('jobBudget', bad), bad).toBe(true)
    // The monthly cap keeps its own bounds.
    expect(checkField('money', '$1,000')).toEqual({ value: '$1000' })
  })
})
