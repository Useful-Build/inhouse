// The start's model check against the brand's real settings rows in D1 (#159 round 1, high 2a): the same rule route 29
// applies. Expected values are literals. Ways it can fail: a model switched off, unpriced or unknown reads as usable, or
// a priced model that's on reads as off.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { openStores } from '../../db/stores.ts'
import { CATALOG } from '../../model/catalog.ts'
import { resetUsage, setSetting } from '../../usage/test-fixtures.ts'
import { modelUsable } from './model-check.ts'

const stores = openStores(env)
beforeEach(async () => { await resetUsage(null) })

describe('modelUsable over D1 settings', () => {
  it('a priced model that is on → true; switched off → false', async () => {
    expect(await modelUsable(stores)('sonnet')).toBe(true)
    await setSetting('tm:sonnet:on', 'off')
    expect(await modelUsable(stores)('sonnet')).toBe(false)
    expect(await modelUsable(stores)('opus')).toBe(true)
  })

  it('an unpriced model → false; an unknown id → false', async () => {
    const unpriced = CATALOG.map(m => (m.id === 'sonnet' ? { ...m, price: null } : m))
    expect(await modelUsable(stores, unpriced)('sonnet')).toBe(false)
    expect(await modelUsable(stores)('nope')).toBe(false)
  })
})
