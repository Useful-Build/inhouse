import { describe, expect } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { CAN_KEYS } from '../../../shared/contract/keys'
import { settingRow } from '../../../shared/contract/settings-table'
import type { Can } from '../../agent/types'
import type { Row } from './content'
import { allowance } from './allowance'
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
  test.prop([fc.boolean(), fc.boolean()])('a model row: the effort needs technical, the switch also takes switchModelOff', (tech, off) => {
    const a = allowance(row({ kind: 'mode', key: 'tm:fable:effort' }), canOf([...(tech ? ['editTechnical'] : []), ...(off ? ['switchModelOff'] : [])]))
    expect(a).toEqual({ control: tech || off, effort: tech, switch: tech || off })
  })
  test('without me() nothing is taken away', () => {
    expect(allowance(row({ key: 't:tone' }), undefined)).toEqual({ control: true, effort: true, switch: true })
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
