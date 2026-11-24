import { describe, expect } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { CAN_KEYS } from '../../../shared/contract/keys'
import { EXACT_ROWS, settingRow } from '../../../shared/contract/settings-table'
import type { Can } from '../../agent/types'
import type { Row } from './content'
import { allowance, mayEditNotify, pageResources, showsRemove } from './allowance'
import { nowIs } from './now-is'

const row = (r: Partial<Row>): Row => ({ title: 't', desc: '', kind: 'select', value: '', need: 0, ...r })
const canOf = (on: readonly string[]): Can => Object.fromEntries(CAN_KEYS.map(k => [k, on.includes(k)])) as Can
const KEYS = ['g:name', 'g:tz', 's:cap', 'm:ask', 't:tone', 'l:daily', 'd:chats', 'tm:fable:effort', 'a:0']

describe('allowance', () => {
  test.prop([fc.constantFrom(...KEYS), fc.subarray([...CAN_KEYS])])('a control is allowed exactly when its scope key is', (key, on) => {
    const can = canOf(on)
    const scope = settingRow(key)!.scope
    const want = scope === 'personal' ? true : scope === 'brand' ? can.editBrandSettings : can.editTechnical
    expect(allowance(row({ key }), can).control).toBe(want)
  })
  test.prop([fc.subarray([...CAN_KEYS])])('a row naming a key follows that key, whatever its setting says', on => {
    const can = canOf(on)
    for (const k of CAN_KEYS) expect(allowance(row({ key: 'p:m_x', can: k }), can).control).toBe(can[k])
  })
  test.prop([fc.boolean(), fc.boolean(), fc.boolean()])('a model row: effort needs technical; the switch works both ways with technical or switchModel, whether the model is on or off', (tech, sw, on) => {
    const a = allowance(row({ kind: 'mode', key: 'tm:fable:effort', switchOn: on }), canOf([...(tech ? ['editTechnical'] : []), ...(sw ? ['switchModel'] : [])]))
    expect(a).toEqual({ control: tech || sw, effort: tech, switch: tech || sw })
  })
  test('an Admin (switchModel, no editTechnical) gets the switch on a model that is off, to turn it back on, and no effort picker', () => {
    const a = allowance(row({ kind: 'mode', key: 'tm:fable:effort', switchOn: false }), canOf(['switchModel', 'editBrandSettings', 'invite']), true, 'admin')
    expect(a).toEqual({ control: true, effort: false, switch: true })
  })
  const PERSONAL = Object.keys(EXACT_ROWS).filter(k => EXACT_ROWS[k].scope === 'personal')
  test.prop([fc.constantFrom(...PERSONAL), fc.subarray([...CAN_KEYS]), fc.constantFrom('select', 'text', 'toggle') as fc.Arbitrary<Row['kind']>])(
    'the Inhouse team gets no control on any personal key (the server refuses them), whatever `can` says; a person does', (key, on, kind) => {
      const can = canOf(on)
      expect(allowance(row({ key, kind }), can, true, 'inhouse')).toEqual({ control: false, effort: false, switch: false })
      for (const role of ['member', 'admin'] as const) expect(allowance(row({ key, kind }), can, true, role).control).toBe(true)
    },
  )
  test.prop([fc.subarray([...CAN_KEYS])])('the photo row: no upload for the Inhouse team, the upload for a person', on => {
    const can = canOf(on)
    expect(allowance(row({ kind: 'photo' }), can, true, 'inhouse').control).toBe(false)
    for (const role of ['member', 'admin'] as const) expect(allowance(row({ kind: 'photo' }), can, true, role).control).toBe(true)
  })
  test('without me() the demo takes nothing away, and the product allows nothing', () => {
    expect(allowance(row({ key: 't:tone' }), undefined)).toEqual({ control: true, effort: true, switch: true })
    expect(allowance(row({ key: 't:tone' }), undefined, true)).toEqual({ control: false, effort: false, switch: false })
  })
})

describe('nowIs', () => {
  test.prop([fc.string({ minLength: 1 })])('names a text value as it is', v => { expect(nowIs({ key: 'k', value: v })).toBe(v) })
  test('names the default, a switch and a role', () => {
    expect(nowIs({ value: null })).toBe('the default')
    expect(nowIs({ value: true })).toBe('on')
    expect(nowIs({ role: 'admin', name: 'X' })).toBe('Admin')
    expect(nowIs({ id: 'x' })).toBeNull()
  })
})

describe('pageResources: the pages that read memory', () => {
  test('both Memory pages name memory, so each re-reads it when it opens', () => {
    expect(pageResources('you-memory', false)).toEqual(['memory'])
    expect(pageResources('team-memory', false)).toEqual(['memory'])
    expect(pageResources('team-members', false)).not.toContain('memory')
  })
})

// P5 W4 (review round 2): who edits the Slack notice channels and who sees a channel's Remove follow `me().can`, never a
// role name. Each `can` set is generated, and the expected value is read from that set alone.
describe('the Slack notice gates', () => {
  const go = () => {}
  const channel = row({ kind: 'value', remove: { label: 'Remove #a', title: 't', text: 'x', action: 'Remove', go, can: 'editBrandSettings' } })
  const member = row({ kind: 'select', remove: { label: 'Remove Pat', title: 't', text: 'x', action: 'Remove', go } })
  test.prop([fc.subarray([...CAN_KEYS])])('editing and a channel Remove need editBrandSettings; a member Remove needs remove', on => {
    const can = canOf(on)
    expect(mayEditNotify(can)).toBe(on.includes('editBrandSettings'))
    expect(showsRemove(channel, can)).toBe(on.includes('editBrandSettings'))
    expect(showsRemove(member, can)).toBe(on.includes('remove'))
  })
  test.prop([fc.subarray([...CAN_KEYS])])('nothing to remove shows no Remove; no me() yet edits nothing', on => {
    expect(showsRemove(row({}), canOf(on))).toBe(false)
    expect(mayEditNotify(undefined)).toBe(false)
  })
})
