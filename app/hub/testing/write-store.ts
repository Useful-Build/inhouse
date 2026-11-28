// The fake Shopify write store's state, kept in the singleton `__test-fakes__` SignIn Durable Object's SQLite KV (#619).
//
// Every upstream request of the hub's test build is served in that one DO (signin.ts `upstreamFor`), but the fake lives
// in its isolate's module memory. When that isolate restarts, a fresh module builds a fresh fake that has issued no
// token, so the hub's saved token gets a 401 (a definite failure: the outbox ends the send `failed`) and the write log a
// spec counts goes back to zero. Bound here, the fake reads its state back from the DO's storage on its first use in an
// isolate and writes it there after every request, `set` and `reset`.
//
// Layout: one key for every field but the logs (the tokens, stores, faults and idempotency keys: small), and one key per
// log entry (the logs grow with every request, so a request writes only its own entries, not the whole log again).
//
// Rules: as ./index.ts. Reached only from ./index.ts and ./fakes.ts, so the deployable bundle drops it.
import {
  WRITE_LOG_NAMES,
  type FakeShopifyWriteCore,
  type FakeShopifyWriteUpstream,
  type WriteLogName,
} from '../../test/upstreams/shopify/write/server'

export type FakeKv = Pick<SyncKvStorage, 'get' | 'put' | 'delete' | 'list'>

export const WRITE_STORE_CORE_KEY = 'test-fakes:shopify-write:core'
const logPrefix = (name: WriteLogName) => `test-fakes:shopify-write:log:${name}:`
/** Zero-padded, so the KV's key order is the log's order. */
const logKey = (name: WriteLogName, i: number) => `${logPrefix(name)}${String(i).padStart(10, '0')}`

export type WriteStore = { save: () => void }

/**
 * Binds `fake` to `kv`: puts back the state kept there (none kept: keeps the fake's own, and writes it), then keeps
 * every later change. Returns `save`, for changes made outside a request (the hook's `set` and `reset`).
 */
export function bindWriteStore(fake: FakeShopifyWriteUpstream, kv: FakeKv): WriteStore {
  const core = kv.get<FakeShopifyWriteCore>(WRITE_STORE_CORE_KEY)
  if (core !== undefined) {
    const logs = Object.fromEntries(WRITE_LOG_NAMES.map(n => [n, [...kv.list({ prefix: logPrefix(n) })].map(([, v]) => v)]))
    fake.restore(core, logs as Pick<FakeShopifyWriteUpstream, WriteLogName>)
  }
  // Per log: the array the stored entries came from and how many of them are stored. A different array (a reset
  // replaced it) or a shorter one is written again from the start.
  const kept = new Map<WriteLogName, { arr: unknown[]; n: number }>(
    WRITE_LOG_NAMES.map(n => [n, { arr: core !== undefined ? fake[n] : [], n: core !== undefined ? fake[n].length : 0 }]),
  )
  const save = () => {
    kv.put(WRITE_STORE_CORE_KEY, fake.snapshot())
    for (const name of WRITE_LOG_NAMES) {
      const arr: unknown[] = fake[name]
      let k = kept.get(name)!
      if (k.arr !== arr || arr.length < k.n) {
        for (const [key] of [...kv.list({ prefix: logPrefix(name) })]) kv.delete(key)
        k = { arr, n: 0 }
      }
      for (let i = k.n; i < arr.length; i++) kv.put(logKey(name, i), arr[i])
      kept.set(name, { arr, n: arr.length })
    }
  }
  fake.onChange = save
  save()
  return { save }
}
