// The fake Shopify write store's state, kept in the singleton `__test-fakes__` SignIn Durable Object's SQLite KV (#619).
//
// Every upstream request of the hub's test build is served in that one DO (signin.ts `upstreamFor`), but the fake lives
// in its isolate's module memory. When that isolate restarts, a fresh module builds a fresh fake that has issued no
// token, so the hub's saved token gets a 401 (a definite failure: the outbox ends the send `failed`) and the write log a
// spec counts goes back to zero. Bound here, the fake reads its state back from the DO's storage on its first use in an
// isolate and writes it there after every request, `set` and `reset`.
//
// Layout: one key for what requests change but the logs (the tokens, stores, faults and idempotency keys: small), and
// one key per log entry (the logs grow with every request, so a request writes only its own entries, not the whole log
// again). The code-owned values (API version, credentials, scope, products) are never kept: they come from the code.
//
// #687: an eval or candidate hub's DO storage can outlive a deploy. The kept core carries the version of the code that
// wrote it (server.ts writeStateVersion); one from other code (an older shape, another fixture or API version, or a
// foreign value) is dropped with its logs, and the fake starts clean, as after a first deploy.
//
// Writes are unconfirmed (async `put`/`delete` with `allowUnconfirmed`): a DO holds its answers until a confirmed write
// is durable, and every fake request writes, so confirmed writes held each card-facts read (one per collected call since
// #555) and made #557's 500-call loop a quarter slower on the sandbox, past its turn's time. An unconfirmed write is
// still flushed, in order, before the isolate goes; a failed one resets the object (and is logged here). The sync and
// async KV APIs share one table (`__cf_kv`), so the sync reads see these writes.
//
// Rules: as ./index.ts. Reached only from ./index.ts and ./fakes.ts, so the deployable bundle drops it.
import { WRITE_LOG_NAMES, type FakeShopifyWriteUpstream, type WriteLogName } from '../../test/upstreams/shopify/write/server'

/** The singleton DO's storage as the fakes use it: sync KV reads (and the hook's var overrides), unconfirmed async writes. */
export interface FakeStorage {
  kv: Pick<SyncKvStorage, 'get' | 'put' | 'delete' | 'list'>
  put(entries: Record<string, unknown>, options: { allowUnconfirmed: true }): Promise<void>
  delete(keys: string[], options: { allowUnconfirmed: true }): Promise<number>
}

/** The async KV API takes at most 128 keys per call. */
const KEYS_PER_CALL = 128
const loud = (what: string) => (e: unknown) => {
  console.error(`fake write store: ${what} failed (${e instanceof Error ? e.name : 'error'}); the DO resets`)
}

export const WRITE_STORE_CORE_KEY = 'test-fakes:shopify-write:core'
const logPrefix = (name: WriteLogName) => `test-fakes:shopify-write:log:${name}:`
/** Zero-padded, so the KV's key order is the log's order. */
const logKey = (name: WriteLogName, i: number) => `${logPrefix(name)}${String(i).padStart(10, '0')}`

export type WriteStore = { save: () => void; restored: boolean }

/**
 * Binds `fake` to `kv`: puts back the state kept there when the code that wrote it is this code (none kept, or kept by
 * other code: keeps the fake's own and writes it over), then keeps every later change. Returns `save`, for changes
 * made outside a request (the hook's `set` and `reset`), and whether kept state was put back.
 */
export function bindWriteStore(fake: FakeShopifyWriteUpstream, storage: FakeStorage): WriteStore {
  const { kv } = storage
  const core = kv.get<unknown>(WRITE_STORE_CORE_KEY)
  const logs = () => Object.fromEntries(WRITE_LOG_NAMES.map(n => [n, [...kv.list({ prefix: logPrefix(n) })].map(([, v]) => v)]))
  const restored = core !== undefined && fake.restore(core, logs() as Pick<FakeShopifyWriteUpstream, WriteLogName>)
  // Per log: the array the stored entries came from and how many of them are stored. A different array (a reset
  // replaced it, or nothing was restored) or a shorter one is written again from the start, its old keys deleted.
  const kept = new Map<WriteLogName, { arr: unknown[]; n: number }>(
    WRITE_LOG_NAMES.map(n => [n, { arr: restored ? fake[n] : [], n: restored ? fake[n].length : 0 }]),
  )
  const save = () => {
    const gone: string[] = []
    const puts: [string, unknown][] = [[WRITE_STORE_CORE_KEY, fake.snapshot()]]
    for (const name of WRITE_LOG_NAMES) {
      const arr: unknown[] = fake[name]
      let k = kept.get(name)!
      if (k.arr !== arr || arr.length < k.n) {
        for (const [key] of kv.list({ prefix: logPrefix(name) })) gone.push(key)
        k = { arr, n: 0 }
      }
      for (let i = k.n; i < arr.length; i++) puts.push([logKey(name, i), arr[i]])
      kept.set(name, { arr, n: arr.length })
    }
    // Deletes first, then puts (a key a reset cleared and a later entry wrote again ends written): the KV applies
    // unawaited writes in the order they're made.
    for (let i = 0; i < gone.length; i += KEYS_PER_CALL) {
      void storage.delete(gone.slice(i, i + KEYS_PER_CALL), { allowUnconfirmed: true }).catch(loud('a delete'))
    }
    for (let i = 0; i < puts.length; i += KEYS_PER_CALL) {
      void storage.put(Object.fromEntries(puts.slice(i, i + KEYS_PER_CALL)), { allowUnconfirmed: true }).catch(loud('a put'))
    }
  }
  fake.onChange = save
  save()
  return { save, restored }
}
