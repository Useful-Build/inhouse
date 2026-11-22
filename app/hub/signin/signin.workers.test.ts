// SignIn on real SQLite storage (workerd, the test config). The upstream is a fake shop registered on PR0's seam for
// the test config's invented shop handle; nothing here reaches a network.
import { env, evictAllDurableObjects, reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testUpstreams } from '../testing/index'
import { FIXTURE_ACCOUNT, FIXTURE_API_VERSION } from '../registry/testing/fixture-connector'
import type { SignInRecord } from './core'
import { FakeShop } from './testing/kit'

const HOST = 'example-fixture.myshopify.com'
const ok = { ok: true, value: { data: { shop: { name: 'Example Fixture' } } } }
const stub = () => env.SIGNIN.get(env.SIGNIN.idFromName(FIXTURE_ACCOUNT))
const query = (document = '{ shop { name } }') => stub().query({ accountId: FIXTURE_ACCOUNT, document, apiVersion: FIXTURE_API_VERSION })
const record = () => runInDurableObject(stub(), (_i, state) => state.storage.kv.get<SignInRecord>('record'))

let shop: FakeShop

beforeEach(async () => {
  await reset()
  shop = new FakeShop(() => Date.now())
  testUpstreams.set(HOST, shop.upstream)
})
afterEach(() => {
  testUpstreams.delete(HOST)
})

describe('SignIn on SQLite storage', () => {
  it('grants once and stores only the envelope', async () => {
    expect(await query()).toEqual(ok)
    expect(await query()).toEqual(ok)
    expect(shop.grants).toBe(1)
    const r = (await record())!
    expect(r).toMatchObject({ accountId: FIXTURE_ACCOUNT, state: 'active', generation: 1, token: { kid: 'ktest-2' } })
    const token = shop.reads[0]!.token
    const everything = await runInDurableObject(stub(), (_i, state) => JSON.stringify([...state.storage.kv.list()]))
    expect(everything).not.toContain(token)
    expect(everything).not.toContain(env.SHOPIFY_CLIENT_SECRET)
  })

  it('keeps one grant across eviction: the token is in storage, not memory', async () => {
    expect(await query()).toEqual(ok)
    await evictAllDurableObjects()
    expect(await query()).toEqual(ok)
    await evictAllDurableObjects()
    expect(await query()).toEqual(ok)
    expect(shop.grants).toBe(1)
  })

  it('the alarm refreshes once the refresh is due, and does nothing before', async () => {
    expect(await query()).toEqual(ok)
    expect(await runDurableObjectAlarm(stub())).toBe(true) // not due yet: no grant
    expect(shop.grants).toBe(1)
    await runInDurableObject(stub(), (_i, state) => {
      const r = state.storage.kv.get<SignInRecord>('record')!
      const now = Date.now()
      state.storage.kv.put('record', { ...r, obtainedAtMs: now - 13 * 3600_000, expiresAtMs: now + 11 * 3600_000 })
      return state.storage.setAlarm(now)
    })
    expect(await runDurableObjectAlarm(stub())).toBe(true)
    expect(shop.grants).toBe(2)
    expect(await record()).toMatchObject({ generation: 2, failures: 0 })
  })

  it('refuses a mutation before any upstream call', async () => {
    expect(await query('mutation { productDelete(input: { id: "1" }) { deletedProductId } }')).toMatchObject({
      ok: false,
      error: { code: 'write_refused' },
    })
    expect(shop.grants + shop.reads.length).toBe(0)
  })

  it('disconnect wins and pending items are one-use', async () => {
    expect(await query()).toEqual(ok)
    expect(await stub().disconnect(FIXTURE_ACCOUNT)).toEqual({ ok: true, value: { generation: 2 } })
    expect(await record()).toMatchObject({ state: 'disconnected', token: null })
    expect(await query()).toMatchObject({ ok: false, error: { code: 'not_configured' } })
    expect(await stub().putPending('state-1', { v: 1 }, 60_000)).toMatchObject({ ok: true })
    expect(await stub().takePending('state-1')).toEqual({ ok: true, value: { v: 1 } })
    expect(await stub().takePending('state-1')).toEqual({ ok: true, value: null })
  })
})
