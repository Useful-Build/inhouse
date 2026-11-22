import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { checkGrantedScopes, describeScopeMismatch } from './scopes'

const handle = fc.stringMatching(/^(read|write)_[a-z]{1,8}$/)
const handles = fc.uniqueArray(handle, { maxLength: 6 })

describe('the granted-scope check', () => {
  test.prop([handles, handles, handles])(
    'passes exactly when granted is within read and required is within granted',
    (granted, read0, required0) => {
      const read = read0.filter(s => s.startsWith('read_'))
      const required = required0.filter(s => read.includes(s))
      const result = checkGrantedScopes(granted.join(', '), { read, required })
      const expected = granted.every(s => read.includes(s)) && required.every(s => granted.includes(s))
      expect(result.ok).toBe(expected)
    },
  )

  test.prop([handles, fc.stringMatching(/^write_[a-z]{1,8}$/)])('any write_* scope fails, even beside allowed ones', (read0, write) => {
    const read = read0.filter(s => s.startsWith('read_'))
    const result = checkGrantedScopes([...read, write].join(','), { read, required: [] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.extra).toContain(write)
  })

  it('a missing scope field fails closed', () => {
    expect(checkGrantedScopes(undefined, { read: ['read_orders'], required: [] }).ok).toBe(false)
    expect(checkGrantedScopes(null, { read: ['read_orders'], required: [] }).ok).toBe(false)
  })

  it('splits on commas, trims and drops empties; no prefix matching', () => {
    expect(checkGrantedScopes(' read_orders, ,read_returns,', { read: ['read_orders', 'read_returns'], required: ['read_returns'] })).toEqual({
      ok: true,
      scopes: ['read_orders', 'read_returns'],
    })
    expect(checkGrantedScopes('read_orders_all', { read: ['read_orders'], required: [] }).ok).toBe(false)
  })

  it('names the extra and missing handles, and only handle-shaped ones', () => {
    const r = checkGrantedScopes('write_orders,<script>', { read: ['read_returns'], required: ['read_returns'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(describeScopeMismatch(r)).toBe('extra write_orders; missing read_returns')
  })
})
