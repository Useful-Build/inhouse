// The session store adapter (P3 R1). Runs in the session process and mirrors the SDK's transcript to the Worker's store
// through the loopback proxy's `/store/*` route; the proxy adds the run's token, so the adapter holds none.
//
// Checkpoint and repair (P0 S1): the SDK drops a batch after three failed appends (emitting `mirror_error`), and a resume
// from a store missing a batch fails. So the adapter keeps every batch of the run until the store has confirmed it. At
// the run's end `checkpoint()` waits for appends still in flight, re-sends each batch the store never confirmed under its
// own part id (so it lands in its place, and a copy that did land is overwritten, not doubled), then loads every key the
// run wrote and checks each uuid the run sent is there. Only then does the run emit `checkpoint`.
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { StoreLoadResult, StoreSubkeys, type StoreKey } from '../../../shared/protocol/index.ts'

export type Fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array }) => Promise<Response>

type Batch = { key: SessionKey; entries: SessionStoreEntry[]; part: string; confirmed: boolean }

export type CheckpointResult = { ok: true; entries: number; repaired: number } | { ok: false; error: string; repaired: number }

export type StoreAdapter = {
  store: SessionStore
  /** Repair, then check every uuid this run sent is in the store. Never throws. */
  checkpoint(): Promise<CheckpointResult>
}

/** Part ids sort in append order: the time, then a counter within this process (one writer per chat at a time). */
export function partId(nowMs: number, n: number): string {
  return `${String(Math.max(0, Math.floor(nowMs))).padStart(15, '0').slice(-15)}-${String(n % 1_000_000).padStart(6, '0')}`
}

const keyId = (k: SessionKey) => JSON.stringify([k.projectKey, k.sessionId, k.subpath ?? null])
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 500)

export function createStoreAdapter(deps: { fetch: Fetch; proxyUrl: string; now?: () => number }): StoreAdapter {
  const base = `${deps.proxyUrl.replace(/\/$/, '')}/store`
  const now = deps.now ?? Date.now
  /** Every batch of the run, in append order. */
  const batches: Batch[] = []
  /** Unconfirmed batches by their content: the SDK retries a batch with the same key and entries; it keeps its part. */
  const unconfirmed = new Map<string, Batch>()
  const inFlight = new Set<Promise<unknown>>()
  let counter = 0

  const post = async (op: string, body: unknown): Promise<unknown> => {
    const res = await deps.fetch(`${base}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`store ${op}: ${res.status}`)
    return res.json()
  }
  const send = async (b: Batch, id: string) => {
    await post('append', { key: wireKey(b.key), entries: b.entries, part: b.part })
    b.confirmed = true
    if (unconfirmed.get(id) === b) unconfirmed.delete(id)
  }
  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p)
    const drop = () => inFlight.delete(p)
    p.then(drop, drop)
    return p
  }

  const store: SessionStore = {
    append(key, entries) {
      // The SDK re-sends a batch only after a rejection, so the same content while unconfirmed is that retry. The same
      // content after it was confirmed is a new batch (two identical lines with no uuid, say): its own part.
      const id = JSON.stringify([keyId(key), entries])
      let b = unconfirmed.get(id)
      if (b === undefined) {
        b = { key, entries, part: partId(now(), ++counter), confirmed: false }
        batches.push(b)
        unconfirmed.set(id, b)
      }
      return track(send(b, id))
    },
    async load(key) {
      const r = StoreLoadResult.parse(await post('load', { key: wireKey(key) }))
      return r.entries as SessionStoreEntry[] | null
    },
    async listSubkeys(key) {
      return StoreSubkeys.parse(await post('list-subkeys', { key: { projectKey: key.projectKey, sessionId: key.sessionId } })).subkeys
    },
  }

  async function checkpoint(): Promise<CheckpointResult> {
    // An append still in flight may yet land: wait for it before deciding what to re-send.
    await Promise.allSettled([...inFlight])
    let repaired = 0
    for (const [id, b] of [...unconfirmed]) {
      try {
        await send(b, id)
        repaired++
      } catch (e) {
        return { ok: false, error: `repair of part ${b.part} failed: ${errorText(e)}`, repaired }
      }
    }
    const byKey = new Map<string, { key: SessionKey; uuids: Set<string> }>()
    for (const b of batches) {
      const k = byKey.get(keyId(b.key)) ?? { key: b.key, uuids: new Set<string>() }
      for (const e of b.entries) if (typeof e.uuid === 'string') k.uuids.add(e.uuid)
      byKey.set(keyId(b.key), k)
    }
    let checked = 0
    for (const { key, uuids } of byKey.values()) {
      let stored: SessionStoreEntry[] | null
      try {
        stored = await store.load(key)
      } catch (e) {
        return { ok: false, error: `load for the check failed: ${errorText(e)}`, repaired }
      }
      const have = new Set((stored ?? []).map((e) => e.uuid).filter((u): u is string => typeof u === 'string'))
      const missing = [...uuids].filter((u) => !have.has(u)).length
      if (missing > 0) return { ok: false, error: `${missing} of ${uuids.size} entries missing from the store`, repaired }
      checked += uuids.size
    }
    return { ok: true, entries: checked, repaired }
  }

  return { store, checkpoint }
}

function wireKey(k: SessionKey): StoreKey {
  return k.subpath === undefined ? { projectKey: k.projectKey, sessionId: k.sessionId } : { projectKey: k.projectKey, sessionId: k.sessionId, subpath: k.subpath }
}
