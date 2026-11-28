// The connections index (Stage 1 M4-R1, N35): one reserved SignIn object, `__connections__`, lists each connection's
// account id and slug. It holds no record, credential or tool; each connection's own object holds those.
//
// Order (gateway.ts): prepare writes the record, then the index; remove tombstones the record (revoking what it can),
// then takes the index entry out. So whatever crashes between the two, every listed id has a record in its object (a live
// one, or a tombstone a second remove clears), and nothing listed can't be removed. A prepare that crashed before its
// index write leaves an unlisted record with no credential; the same prepare again lists it (prepare is idempotent).
// Each operation below is one synchronous transaction in the index object, so parallel prepares can't pass the cap.
// Each entry names the generation that listed it, so a stale prepare's or remove's late step can't take out a newer
// prepare's entry: an add keeps the newest generation, and a remove takes an entry out only up to the generation it saw.
// Key rotation and teardown walk this list (index/index.ts ServerGateway).
import type { SyncStore } from '../signin/core'
import { CONNECTION_CAPS } from '../index/contract'

/** The index object's name. Can't collide with an account id (`ACCOUNT_ID` has no underscore). */
export const INDEX_OBJECT = '__connections__'
const ENTRY = 'ix:'

export type IndexEntry = { accountId: string; slug: string; generation: number; addedAtMs: number }
export type IndexAdd = 'added' | 'present' | 'cap'

/** Lists the connection, unless 20 are listed already. Listed already: kept, at the newer of the two generations. */
export function indexAdd(store: SyncStore, entry: { accountId: string; slug: string; generation: number }, nowMs: number): IndexAdd {
  return store.transactionSync(() => {
    const held = store.get<IndexEntry>(ENTRY + entry.accountId)
    if (held !== undefined) {
      if (entry.generation > held.generation) store.put<IndexEntry>(ENTRY + entry.accountId, { ...held, generation: entry.generation })
      return 'present'
    }
    let n = 0
    for (const _ of store.list<IndexEntry>(ENTRY)) n++
    if (n >= CONNECTION_CAPS.perBrand) return 'cap'
    store.put<IndexEntry>(ENTRY + entry.accountId, { accountId: entry.accountId, slug: entry.slug, generation: entry.generation, addedAtMs: nowMs })
    return 'added'
  })
}

/**
 * Takes the connection out of the list: only an entry listed at `upTo` or an earlier generation (null: whatever it is,
 * for an id whose object holds no record). True when it was taken out.
 */
export function indexRemove(store: SyncStore, accountId: string, upTo: number | null): boolean {
  return store.transactionSync(() => {
    const held = store.get<IndexEntry>(ENTRY + accountId)
    if (held === undefined || (upTo !== null && held.generation > upTo)) return false
    return store.delete(ENTRY + accountId)
  })
}

/** Every listed connection, in account id order. */
export function indexList(store: SyncStore): IndexEntry[] {
  return [...store.list<IndexEntry>(ENTRY)].map(([, e]) => e).sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0))
}
