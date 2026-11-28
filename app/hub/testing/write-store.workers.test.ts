// #619: the fake Shopify write store survives a restart of the isolate that serves it. On a deployed test build that's
// the singleton `__test-fakes__` SignIn DO; a restart there runs this module graph afresh, so each "restart" below is a
// fresh module instance (vi.resetModules, then import again) bound to the same storage. Ways it can fail, written first:
//  1. a token issued before the restart gets a 401 after it (the send fails definitely: the bug);
//  2. the stores (orders, stock, idempotency keys), the faults or the write log a spec counts go back to their start;
//  3. a `timeout` write, logged before the fake hangs, is lost if the isolate restarts while it hangs;
//  4. `reset` stops holding: its cleared logs come back after a restart, or it forgets the tokens (it keeps them);
//  5. over any mix of requests and restarts, the restored fake differs from one that never restarted.
// Storage is an in-memory stand-in for the DO's SyncKvStorage (get, put, delete, list by prefix in key order, values
// copied in and out as the DO's structured clone does); the last test runs the same binding on the DO's real storage.
import { env, runInDurableObject } from 'cloudflare:test'
import { fc, test } from '@fast-check/vitest'
import { describe, expect, vi } from 'vitest'
import { FAKE_WRITE_OPS } from '../../test/upstreams/shopify/write/ops/index'
import {
  FakeShopifyWriteUpstream,
  SHOPIFY_WRITE_API_VERSION,
  SHOPIFY_WRITE_HOST,
  SHOPIFY_WRITE_TEST_CLIENT_ID,
  SHOPIFY_WRITE_TEST_CLIENT_SECRET,
  WRITE_LOG_NAMES,
} from '../../test/upstreams/shopify/write/server'
import { TEST_FAKES_DO_NAME, upstreamFor } from '../signin/signin'
import { bindWriteStore, WRITE_STORE_CORE_KEY, type FakeKv } from './write-store'

class MemKv implements FakeKv {
  readonly m = new Map<string, unknown>()
  get<T>(key: string): T | undefined {
    return this.m.has(key) ? (structuredClone(this.m.get(key)) as T) : undefined
  }
  put<T>(key: string, value: T): void {
    this.m.set(key, structuredClone(value))
  }
  delete(key: string): boolean {
    return this.m.delete(key)
  }
  *list<T>(o?: SyncKvListOptions): Iterable<[string, T]> {
    for (const k of [...this.m.keys()].sort()) if (k.startsWith(o?.prefix ?? '')) yield [k, structuredClone(this.m.get(k)) as T]
  }
}

/** A fresh module instance of the seam and the hook, as an isolate restart builds them. */
async function restart() {
  vi.resetModules()
  const seam = await import('./index')
  const hook = await import('./fakes')
  return { seam, hook }
}
type Instance = Awaited<ReturnType<typeof restart>>

const tokenRequest = () =>
  new Request(`https://${SHOPIFY_WRITE_HOST}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: SHOPIFY_WRITE_TEST_CLIENT_ID, client_secret: SHOPIFY_WRITE_TEST_CLIENT_SECRET }).toString(),
  })
const gqlRequest = (token: string, key: string, variables: Record<string, unknown>, signal?: AbortSignal) => {
  const op = FAKE_WRITE_OPS.find(o => o.key === key)!
  return new Request(`https://${SHOPIFY_WRITE_HOST}/admin/api/${SHOPIFY_WRITE_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query: op.document(variables), variables }),
    signal,
  })
}
const tagAdd = (token: string, tag: string, signal?: AbortSignal) =>
  gqlRequest(token, 'shopify.order.tag_add', { tags: [tag], id0: 'gid://shopify/Order/9001' }, signal)
const restock = (token: string, idempotencyKey: string) =>
  gqlRequest(token, 'shopify.inventory.restock', {
    input: { name: 'available', reason: 'restock', changes: [{ inventoryItemId: 'gid://shopify/InventoryItem/8001', locationId: 'gid://shopify/Location/601', delta: 3, changeFromQuantity: null }] },
    idempotencyKey,
  })

const issue = async (i: Instance): Promise<string> => {
  const res = await i.seam.testUpstreamFetch(tokenRequest())
  expect(res.status).toBe(200)
  return ((await res.json()) as { access_token: string }).access_token
}
const op = (i: Instance, kv: FakeKv, input: unknown) => {
  const r = i.hook.runHubFakesInDo(kv, input)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.value as Record<string, unknown>
}
type WriteState = { writes: { operation: string; outcome: string; replayed?: true }[]; orders: { id: string; tags: string[] }[]; faults: Record<string, string> }
const writeState = (i: Instance, kv: FakeKv) => op(i, kv, { op: 'state' }).shopifyWrite as WriteState

describe('the fake write store across a restart (#619)', () => {
  test('a token saved before a restart still works after it; the stores, faults and write log carry over (failures 1, 2)', async () => {
    const kv = new MemKv()
    const a = await restart()
    a.seam.attachFakeStorage(kv)
    const token = await issue(a)
    expect((await a.seam.testUpstreamFetch(tagAdd(token, 'before'))).status).toBe(200)
    expect((await a.seam.testUpstreamFetch(restock(token, 'key-1'))).status).toBe(200)
    op(a, kv, { op: 'set', shopifyWrite: { faults: { 'shopify.order.tag_add': 'refuse' } } })

    const b = await restart()
    expect(b.seam.shopifyWrite).not.toBe(a.seam.shopifyWrite)
    b.seam.attachFakeStorage(kv)
    // The saved token: answered, not a 401. The fault set before the restart still holds (the tag is refused).
    const refused = await b.seam.testUpstreamFetch(tagAdd(token, 'refused'))
    expect(refused.status).toBe(200)
    expect(((await refused.json()) as { data: { o0: { userErrors: unknown[] } } }).data.o0.userErrors).toHaveLength(1)
    op(b, kv, { op: 'set', shopifyWrite: { faults: { 'shopify.order.tag_add': 'succeed' } } })
    expect((await b.seam.testUpstreamFetch(tagAdd(token, 'after'))).status).toBe(200)
    // The same idempotency key answers the first answer again: stock moved once, before the restart.
    expect((await b.seam.testUpstreamFetch(restock(token, 'key-1'))).status).toBe(200)
    expect(b.seam.shopifyWrite.stock.get('gid://shopify/InventoryItem/8001|gid://shopify/Location/601')).toBe(13)

    const s = writeState(b, kv)
    expect(s.orders.find(o => o.id === 'gid://shopify/Order/9001')!.tags).toEqual(['existing', 'before', 'after'])
    expect(s.writes.map(w => [w.operation, w.outcome, w.replayed ?? false])).toEqual([
      ['shopify.order.tag_add', 'succeed', false],
      ['shopify.inventory.restock', 'succeed', false],
      ['shopify.order.tag_add', 'refuse', false],
      ['shopify.order.tag_add', 'succeed', false],
      ['shopify.inventory.restock', 'succeed', true],
    ])
    expect(b.seam.shopifyWrite.issuedTokens).toEqual([token])
    // The next token is a new one, not the first again.
    expect(await issue(b)).not.toBe(token)
  })

  test('the control: an unbound fresh instance (the old behavior) answers the saved token with a 401', async () => {
    const a = await restart()
    a.seam.attachFakeStorage(new MemKv())
    const token = await issue(a)
    const b = await restart()
    expect((await b.seam.testUpstreamFetch(tagAdd(token, 'x'))).status).toBe(401)
  })

  test('a timeout write is kept while the fake hangs, before any answer (failure 3)', async () => {
    const kv = new MemKv()
    const a = await restart()
    a.seam.attachFakeStorage(kv)
    const token = await issue(a)
    op(a, kv, { op: 'set', shopifyWrite: { faults: { 'shopify.order.tag_add': 'timeout' } } })
    const abort = new AbortController()
    const hanging = a.seam.testUpstreamFetch(tagAdd(token, 'slow', abort.signal))
    await vi.waitFor(() => expect(a.seam.shopifyWrite.writes).toHaveLength(1))

    const b = await restart()
    b.seam.attachFakeStorage(kv)
    expect(writeState(b, kv).writes).toEqual([{ operation: 'shopify.order.tag_add', variables: { tags: ['slow'], id0: 'gid://shopify/Order/9001' }, outcome: 'timeout' }])
    abort.abort(new Error('deadline'))
    await expect(hanging).rejects.toThrow('deadline')
  })

  test('reset holds across a restart: the logs and stores go back to their start, the issued tokens stay (failure 4)', async () => {
    const kv = new MemKv()
    const a = await restart()
    a.seam.attachFakeStorage(kv)
    const token = await issue(a)
    expect((await a.seam.testUpstreamFetch(tagAdd(token, 'gone'))).status).toBe(200)
    op(a, kv, { op: 'reset' })

    const b = await restart()
    b.seam.attachFakeStorage(kv)
    const s = writeState(b, kv)
    expect(s.writes).toEqual([])
    expect(s.orders.find(o => o.id === 'gid://shopify/Order/9001')!.tags).toEqual(['existing'])
    expect(b.seam.shopifyWrite.requests).toEqual([])
    // The log keys reset cleared are gone from storage too: one write after it is the only entry kept.
    expect((await b.seam.testUpstreamFetch(tagAdd(token, 'kept'))).status).toBe(200)
    const c = await restart()
    c.seam.attachFakeStorage(kv)
    expect(writeState(c, kv).writes.map(w => w.operation)).toEqual(['shopify.order.tag_add'])
    expect(c.seam.shopifyWrite.issuedTokens).toEqual([token])
  })

  // Failure 5. Each step is a token request, a tag write with the newest token, a reset or a restart (a fresh fake
  // bound to the same storage). A reference fake gets the same requests and never restarts; the two must match.
  const step = fc.oneof(
    fc.constant({ kind: 'token' as const }),
    fc.constant({ kind: 'restart' as const }),
    fc.constant({ kind: 'reset' as const }),
    fc.string({ minLength: 1, maxLength: 6 }).map(tag => ({ kind: 'tag' as const, tag })),
  )
  test.prop([fc.array(step, { maxLength: 20 })], { numRuns: 60 })('over any mix of requests, resets and restarts, the restored fake matches one that never restarted', async steps => {
    const kv = new MemKv()
    const ref = new FakeShopifyWriteUpstream()
    let live = new FakeShopifyWriteUpstream()
    let store = bindWriteStore(live, kv)
    let token = 'never-issued'
    for (const s of steps) {
      if (s.kind === 'restart') {
        live = new FakeShopifyWriteUpstream()
        store = bindWriteStore(live, kv)
      } else if (s.kind === 'reset') {
        ref.reset()
        live.reset()
        store.save()
      } else if (s.kind === 'token') {
        const [r, l] = [await ref.fetch(tokenRequest()), await live.fetch(tokenRequest())]
        token = ((await r.json()) as { access_token: string }).access_token
        expect(((await l.json()) as { access_token: string }).access_token).toBe(token)
      } else {
        const [r, l] = [await ref.fetch(tagAdd(token, s.tag)), await live.fetch(tagAdd(token, s.tag))]
        expect(l.status).toBe(r.status)
        expect(await l.text()).toBe(await r.text())
      }
    }
    const restored = new FakeShopifyWriteUpstream()
    bindWriteStore(restored, kv)
    for (const f of [live, restored]) {
      expect(f.snapshot()).toEqual(ref.snapshot())
      for (const n of WRITE_LOG_NAMES) expect(f[n]).toEqual(ref[n])
    }
  })
})

// The same binding on the singleton test-fakes DO's real SQLite KV, after a token issued and a write served through
// the hub's own upstream path (signin.ts upstreamFor, which binds the store in the DO): a fresh fake bound to that
// storage, as a restarted isolate builds it, takes the saved token and holds the write.
describe('on the singleton test-fakes DO storage (#619)', () => {
  test('a fresh fake bound to the DO storage takes the token the DO issued and holds its write', async () => {
    const up = await upstreamFor(env)
    const res = await up(tokenRequest())
    const token = ((await res.json()) as { access_token: string }).access_token
    expect((await up(tagAdd(token, 'through-do'))).status).toBe(200)
    const stub = env.SIGNIN.get(env.SIGNIN.idFromName(TEST_FAKES_DO_NAME))
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.kv.get(WRITE_STORE_CORE_KEY)).toBeDefined()
      const fresh = new FakeShopifyWriteUpstream()
      bindWriteStore(fresh, state.storage.kv)
      expect(fresh.issuedTokens).toContain(token)
      expect(fresh.writes.at(-1)).toMatchObject({ operation: 'shopify.order.tag_add', variables: { tags: ['through-do'] }, outcome: 'succeed' })
      const again = await fresh.fetch(tagAdd(token, 'after-restart'))
      expect(again.status).toBe(200)
      expect(fresh.orders.get('gid://shopify/Order/9001')!.tags).toContain('through-do')
    })
  })
})
