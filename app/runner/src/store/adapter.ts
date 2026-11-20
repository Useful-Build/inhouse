// The session store adapter (P3 R1). Runs in the session process and mirrors the SDK's transcript to the Worker's store
// through the loopback proxy's `/store/*` route; the proxy adds the run's token, so the adapter holds none.
//
// Checkpoint and repair (P0 S1): the SDK drops a batch after three failed appends (emitting `mirror_error`), and a resume
// from a store missing a batch fails. So the adapter keeps every batch of the run until the store has confirmed it. At
// the run's end `checkpoint()` waits for appends still in flight, re-sends each batch the store never confirmed under its
// own part id (so it lands in its place, and a copy that did land is overwritten, not doubled), then loads every key the
// run wrote and checks each uuid the run sent is there. Only then does the run emit `checkpoint`.
//
// The SDK's last flush (and its retries) ends before the query's iteration does (sdk.mjs awaits its mirror batcher's
// flush before it ends the stream), and the session checkpoints only after that. An SDK retry that still comes after a
// repair reuses the batch's part (by its uuids), so it overwrites the copy rather than doubling it.
import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { StoreLoadResult, StoreSubkeys, type ResumeExpect, type StoreKey } from '../../../shared/protocol/index.ts'

export type Fetch = (url: string, init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<Response>

/** One batch of the run. Once the store confirms it, its entries are dropped: only its uuids are kept, for the check. */
type Batch = { key: SessionKey; entries: SessionStoreEntry[] | null; uuids: string[]; part: string; confirmed: boolean; sdkRejected: boolean }

/**
 * The main transcript as the store holds it after the check: its total length, and the last entry that has a uuid
 * (null when none has one). Subagent transcripts don't count.
 */
export type MainState = { mainEntries: number; lastUuid: string | null; lastUuidIndex: number | null }

/** `entries`: the uuids this run sent, all found in the store. `main`: null when this run wrote no main-transcript batch. */
export type CheckpointResult = { ok: true; entries: number; repaired: number; main: MainState | null } | { ok: false; error: string; repaired: number }

/**
 * A resume's check of the store against the Worker's `expect` (protocol v2), made on the SDK's first load of the main
 * transcript, before the query's first model call: `pending` until that load, then `ok` or `failed`.
 */
export type ResumeCheck = { state: 'pending' } | { state: 'ok' } | { state: 'failed'; error: string }

export type StoreAdapter = {
  store: SessionStore
  /** Repair, then check every uuid this run sent is in the store. Never throws. */
  checkpoint(): Promise<CheckpointResult>
  /** Where a resume's check stands (`ok` for a run that isn't a resume). */
  resumeCheck(): ResumeCheck
}

/** Why `entries` (the main transcript, as loaded) doesn't hold what `expect` says it must; null when it does. */
export function resumeMismatch(entries: readonly { uuid?: unknown }[], expect: ResumeExpect): string | null {
  if (entries.length < expect.mainEntries) return `the store holds ${entries.length} main-transcript entries, the Worker expects at least ${expect.mainEntries}`
  if (expect.lastUuid !== null && expect.lastUuidIndex !== null && entries[expect.lastUuidIndex]?.uuid !== expect.lastUuid) {
    return `the main-transcript entry at ${expect.lastUuidIndex} isn't the one the Worker expects`
  }
  return null
}

/** Part ids sort in append order: the time, then a counter within this process (one writer per chat at a time). */
export function partId(nowMs: number, n: number): string {
  return `${String(Math.max(0, Math.floor(nowMs))).padStart(15, '0').slice(-15)}-${String(n % 1_000_000).padStart(6, '0')}`
}

function mainState(entries: SessionStoreEntry[]): MainState {
  for (let i = entries.length - 1; i >= 0; i--) {
    const uuid = entries[i]!.uuid
    if (typeof uuid === 'string' && uuid !== '') return { mainEntries: entries.length, lastUuid: uuid, lastUuidIndex: i }
  }
  return { mainEntries: entries.length, lastUuid: null, lastUuidIndex: null }
}

const keyId = (k: SessionKey) => JSON.stringify([k.projectKey, k.sessionId, k.subpath ?? null])
const errorText = (e: unknown) => String(e instanceof Error ? e.message : e).slice(0, 500)

/** Thrown out of the SDK's load when a resume's check fails, so the query ends before any model call. */
export class ResumeCheckError extends Error {}

export function createStoreAdapter(deps: {
  fetch: Fetch
  proxyUrl: string
  now?: () => number
  /** A resume's `expect` (null or absent: not a resume, nothing to check). */
  expect?: ResumeExpect | null
  /** Called once when a resume's check fails (the session aborts its query). */
  onResumeRefused?: (error: string) => void
}): StoreAdapter {
  const base = `${deps.proxyUrl.replace(/\/$/, '')}/store`
  const now = deps.now ?? Date.now
  /** Every batch of the run, in append order. */
  const batches: Batch[] = []
  /** Unconfirmed batches by their content: the SDK retries a batch with the same key and entries; it keeps its part. */
  const unconfirmed = new Map<string, Batch>()
  /** Confirmed batches by their key and uuids: a retry that comes after a repair confirmed it keeps its part too. */
  const confirmedByUuids = new Map<string, Batch>()
  /**
   * Batches without uuids that a repair (or a retry after it) confirmed while the SDK's last append of them was
   * rejected, by their content: the SDK's retry is still to come and keeps the part. Taken out by that retry, so the
   * same content after it (two identical lines with no uuid) is a new batch with its own part.
   */
  const awaitingRetry = new Map<string, Batch>()
  const inFlight = new Set<Promise<unknown>>()
  let counter = 0
  let check: ResumeCheck = deps.expect ? { state: 'pending' } : { state: 'ok' }
  /** The main transcript's key, from the SDK's own load or append (the SDK derives its project key). */
  let mainKey: SessionKey | null = null

  const post = async (op: string, body: unknown): Promise<unknown> => {
    const res = await deps.fetch(`${base}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`store ${op}: ${res.status}`)
    return res.json()
  }
  const uuidKey = (b: { key: SessionKey; uuids: string[] }) => (b.uuids.length === 0 ? null : JSON.stringify([keyId(b.key), b.uuids]))
  const send = async (b: Batch, id: string, entries: SessionStoreEntry[]) => {
    await post('append', { key: wireKey(b.key), entries, part: b.part })
    b.confirmed = true
    b.entries = null
    if (unconfirmed.get(id) === b) unconfirmed.delete(id)
    const u = uuidKey(b)
    if (u !== null) confirmedByUuids.set(u, b)
  }
  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p)
    const drop = () => inFlight.delete(p)
    p.then(drop, drop)
    return p
  }

  const store: SessionStore = {
    append(key, entries) {
      // The SDK re-sends a batch only after a rejection, so the same content while unconfirmed is that retry, and the
      // same uuids after it was confirmed (by a repair) is that retry too. Without uuids, the same content after a repair
      // confirmed it is that retry only while the SDK's last append of it was rejected; otherwise (two identical lines
      // with no uuid, say) it's a new batch with its own part.
      const id = JSON.stringify([keyId(key), entries])
      const uuids = entries.map((e) => e.uuid).filter((u): u is string => typeof u === 'string')
      let b = unconfirmed.get(id)
      if (b === undefined) {
        const u = uuidKey({ key, uuids })
        b = u === null ? awaitingRetry.get(id) : confirmedByUuids.get(u)
        if (u === null) awaitingRetry.delete(id)
      }
      if (b === undefined) {
        b = { key, entries, uuids, part: partId(now(), ++counter), confirmed: false, sdkRejected: false }
        batches.push(b)
        unconfirmed.set(id, b)
      }
      const batch = b
      return track(
        send(batch, id, entries).then(
          () => void (batch.sdkRejected = false),
          (e: unknown) => {
            batch.sdkRejected = true
            // Confirmed already (by a repair): the SDK's next retry of this content keeps the part.
            if (batch.confirmed && batch.uuids.length === 0) awaitingRetry.set(id, batch)
            throw e
          },
        ),
      )
    },
    async load(key) {
      const r = StoreLoadResult.parse(await post('load', { key: wireKey(key) }))
      const entries = r.entries as SessionStoreEntry[] | null
      if (key.subpath === undefined) {
        mainKey ??= key
        if (check.state === 'pending' && deps.expect) {
          const why = resumeMismatch(entries ?? [], deps.expect)
          check = why === null ? { state: 'ok' } : { state: 'failed', error: why }
          if (why !== null) deps.onResumeRefused?.(why)
        }
        if (check.state === 'failed') throw new ResumeCheckError(`resume refused: ${check.error}`)
      }
      return entries
    },
    async listSubkeys(key) {
      return StoreSubkeys.parse(await post('list-subkeys', { key: { projectKey: key.projectKey, sessionId: key.sessionId } })).subkeys
    },
  }

  async function checkpoint(): Promise<CheckpointResult> {
    // An append still in flight may yet land: wait for it (and any started meanwhile) before deciding what to re-send.
    while (inFlight.size > 0) await Promise.allSettled([...inFlight])
    let repaired = 0
    for (const [id, b] of [...unconfirmed]) {
      try {
        await send(b, id, b.entries!)
        if (b.uuids.length === 0 && b.sdkRejected) awaitingRetry.set(id, b)
        repaired++
      } catch (e) {
        return { ok: false, error: `repair of part ${b.part} failed: ${errorText(e)}`, repaired }
      }
    }
    const byKey = new Map<string, { key: SessionKey; uuids: Set<string> }>()
    for (const b of batches) {
      const k = byKey.get(keyId(b.key)) ?? { key: b.key, uuids: new Set<string>() }
      for (const u of b.uuids) k.uuids.add(u)
      byKey.set(keyId(b.key), k)
    }
    let checked = 0
    let main: MainState | null = null
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
      if (key.subpath === undefined) {
        if (main !== null) return { ok: false, error: 'this run wrote two main transcripts', repaired }
        main = mainState(stored ?? [])
      }
    }
    // A run that wrote nothing to the main transcript (a resume whose turn wrote nothing, say): its state is what the
    // store holds for the key the SDK loaded.
    if (main === null && mainKey !== null) {
      try {
        main = mainState((await store.load(mainKey)) ?? [])
      } catch (e) {
        return { ok: false, error: `load for the check failed: ${errorText(e)}`, repaired }
      }
    }
    return { ok: true, entries: checked, repaired, main }
  }

  return { store, checkpoint, resumeCheck: () => check }
}

function wireKey(k: SessionKey): StoreKey {
  return k.subpath === undefined ? { projectKey: k.projectKey, sessionId: k.sessionId } : { projectKey: k.projectKey, sessionId: k.sessionId, subpath: k.subpath }
}
