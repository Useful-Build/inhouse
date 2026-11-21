// The session store adapter's checkpoint and repair. Ways it could fail, written first:
// - a batch the SDK dropped after its retries is never re-sent, so a resume misses it ("No conversation found", P0 S1);
// - a re-sent batch lands as a second copy, or out of its place in the transcript;
// - an SDK retry of a batch gets a new part (a duplicate once both land);
// - two identical batches (no uuid) collapse into one part;
// - `checkpoint` passes while an append is still in flight, or while the store is missing an entry it said it took;
// - a repair or a load that fails throws out of `checkpoint` instead of reporting it;
// - an SDK retry that comes after the repair confirmed its batch lands as a second copy (a batch with no uuids too);
// - the main state counts only this run's entries, not the store's total (an earlier run's are in the store too), or
//   indexes the last uuid within this run's entries;
// - a run that wrote two main transcripts (two keys without a subpath) reports one of them as the main state.
import type { SessionKey, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { createStoreAdapter, partId, type StoreAdapter } from '../../src/store/adapter.ts'
import { PROXY_URL, fakeEgress } from '../run/support/fake-egress.ts'
import { gate } from '../run/support/test-seams.ts'

const key: SessionKey = { projectKey: '-work-chat-1', sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11' }

/** As the SDK mirrors a batch: three attempts on rejection, then it drops the batch (and emits mirror_error). */
async function sdkAppend(a: StoreAdapter, k: SessionKey, entries: SessionStoreEntry[]): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await a.store.append(k, entries)
      return true
    } catch {
      // retried
    }
  }
  return false
}

const batchesArb = fc.array(fc.array(fc.constant(null), { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 12 })

describe('checkpoint and repair', () => {
  it.prop([batchesArb, fc.array(fc.boolean(), { minLength: 60, maxLength: 60 })])(
    'whatever appends failed, once the store is back the checkpoint passes and the store holds every entry once, in append order',
    async (shape, failures) => {
      const egress = fakeEgress()
      let n = 0
      egress.fail = (_m, p) => (p === '/store/append' && failures[n++ % failures.length] ? 503 : null)
      const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
      let u = 0
      const batches = shape.map((b) => b.map(() => ({ type: 'user', uuid: `u-${u++}` })))
      for (const b of batches) await sdkAppend(a, key, b)
      egress.fail = () => null
      const cp = await a.checkpoint()
      // u >= 1 (every batch has an entry): the main transcript is all of them, the last uuid last.
      expect(cp).toEqual({ ok: true, entries: u, repaired: expect.any(Number), main: { mainEntries: u, lastUuid: `u-${u - 1}`, lastUuidIndex: u - 1 } })
      expect(egress.entries(key)).toEqual(batches.flat())
    },
  )

  it('an SDK retry keeps its part id (a first attempt that landed is overwritten, not doubled); the same content after it was confirmed gets its own part', async () => {
    const egress = fakeEgress()
    const real = egress.fetch
    let first = true
    // The first append lands in the store, but its answer is lost: the SDK sees a failure and retries.
    egress.fetch = async (url, init) => {
      const res = await real(url, init)
      if (url.endsWith('/store/append') && first) {
        first = false
        return new Response('{"error":"lost"}', { status: 502 })
      }
      return res
    }
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    const title = [{ type: 'custom-title', title: 'x' }]
    await sdkAppend(a, key, title)
    expect(egress.entries(key)).toEqual(title)
    await sdkAppend(a, key, title)
    expect(egress.entries(key)).toEqual([...title, ...title])
    expect(await a.checkpoint()).toMatchObject({ ok: true })
  })

  it('an SDK retry that comes after the repair reuses its part: the store holds the batch once', async () => {
    const egress = fakeEgress()
    egress.fail = (_m, p) => (p === '/store/append' ? 503 : null)
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    const batch = [{ type: 'user', uuid: 'r1' }]
    await expect(a.store.append(key, batch)).rejects.toThrow()
    egress.fail = () => null
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 1, repaired: 1, main: { mainEntries: 1, lastUuid: 'r1', lastUuidIndex: 0 } })
    // The SDK's own retry of the batch, landing after the repair confirmed it.
    await a.store.append(key, batch)
    expect(egress.entries(key)).toEqual(batch)
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 1, repaired: 0, main: { mainEntries: 1, lastUuid: 'r1', lastUuidIndex: 0 } })
  })

  it('a batch with no uuids that the SDK retries after the repair keeps its part; the same content after that is new', async () => {
    const egress = fakeEgress()
    egress.fail = (_m, p) => (p === '/store/append' ? 503 : null)
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    const title = [{ type: 'custom-title', title: 'x' }]
    await expect(a.store.append(key, title)).rejects.toThrow()
    egress.fail = () => null
    // No uuid anywhere: only the length counts.
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 0, repaired: 1, main: { mainEntries: 1, lastUuid: null, lastUuidIndex: null } })
    // The SDK's own retry, landing after the repair confirmed the batch: the same part, so one copy.
    await a.store.append(key, title)
    expect(egress.entries(key)).toEqual(title)
    // The SDK saw that one succeed: the same content again is a second batch.
    await a.store.append(key, title)
    expect(egress.entries(key)).toEqual([...title, ...title])
  })

  it('a dropped batch is re-sent under its own part, so it lands in its place, not at the end', async () => {
    const egress = fakeEgress()
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, key, [{ type: 'user', uuid: 'a' }])
    egress.fail = (_m, p) => (p === '/store/append' ? 503 : null)
    expect(await sdkAppend(a, key, [{ type: 'user', uuid: 'b' }])).toBe(false)
    egress.fail = () => null
    await sdkAppend(a, key, [{ type: 'user', uuid: 'c' }])
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 3, repaired: 1, main: { mainEntries: 3, lastUuid: 'c', lastUuidIndex: 2 } })
    expect(egress.entries(key).map((e) => (e as { uuid: string }).uuid)).toEqual(['a', 'b', 'c'])
  })

  it('waits for an append still in flight before it checks', async () => {
    const egress = fakeEgress()
    const g = gate()
    egress.onAppend = () => g.promise
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    const appending = a.store.append(key, [{ type: 'user', uuid: 'x' }])
    let settled = false
    const cp = a.checkpoint().then((r) => ((settled = true), r))
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(settled).toBe(false)
    g.open()
    await appending
    expect(await cp).toEqual({ ok: true, entries: 1, repaired: 0, main: { mainEntries: 1, lastUuid: 'x', lastUuidIndex: 0 } })
  })

  it('an entry the store said it took but lost fails the check', async () => {
    const egress = fakeEgress()
    egress.onAppend = (p) => void (egress.lose.size === 0 && egress.lose.add(p))
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, key, [{ type: 'user', uuid: 'lost' }])
    await sdkAppend(a, key, [{ type: 'user', uuid: 'kept' }])
    expect(await a.checkpoint()).toMatchObject({ ok: false, error: '1 of 2 entries missing from the store' })
  })

  it('a repair or a load that fails is reported, never thrown', async () => {
    const egress = fakeEgress()
    egress.fail = (_m, p) => (p === '/store/append' ? 503 : null)
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, key, [{ type: 'user', uuid: 'x' }])
    expect(await a.checkpoint()).toMatchObject({ ok: false, error: expect.stringMatching(/^repair of part/) })

    const e2 = fakeEgress()
    const b = createStoreAdapter({ fetch: e2.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(b, key, [{ type: 'user', uuid: 'y' }])
    e2.fail = (_m, p) => (p === '/store/load' ? 500 : null)
    expect(await b.checkpoint()).toMatchObject({ ok: false, error: expect.stringMatching(/^load for the check failed/) })
  })

  it('checks every key the run wrote, subagent transcripts included', async () => {
    const egress = fakeEgress()
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    const sub = { ...key, subpath: 'subagents/agent-1' }
    await sdkAppend(a, key, [{ type: 'user', uuid: 'm' }])
    await sdkAppend(a, sub, [{ type: 'user', uuid: 's' }])
    // The subagent's entry is checked but isn't part of the main transcript.
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 2, repaired: 0, main: { mainEntries: 1, lastUuid: 'm', lastUuidIndex: 0 } })
    expect(await a.store.listSubkeys!({ projectKey: key.projectKey, sessionId: key.sessionId })).toEqual(['subagents/agent-1'])
    egress.parts.get(JSON.stringify([sub.projectKey, sub.sessionId, sub.subpath]))!.clear()
    expect(await a.checkpoint()).toMatchObject({ ok: false })
  })

  it("the main state names the last entry that has a uuid, not the last entry (protocol v2's checkpoint)", async () => {
    const egress = fakeEgress()
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, key, [{ type: 'user', uuid: 'a' }, { type: 'assistant', uuid: 'b' }])
    await sdkAppend(a, key, [{ type: 'custom-title', title: 't' }])
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 2, repaired: 0, main: { mainEntries: 3, lastUuid: 'b', lastUuidIndex: 1 } })
  })

  it("the main state is the store's total: an earlier run's entries count, and the last uuid's index spans both runs", async () => {
    const egress = fakeEgress()
    // An earlier run's two parts, already in the store (their part ids sort before this run's).
    egress.parts.set(
      JSON.stringify([key.projectKey, key.sessionId, null]),
      new Map<string, unknown[]>([
        ['000000000000001-000000', [{ type: 'user', uuid: 'old-1' }, { type: 'assistant', uuid: 'old-2' }]],
        ['000000000000001-000001', [{ type: 'user', uuid: 'old-3' }, { type: 'custom-title', title: 't' }]],
      ]),
    )
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, key, [{ type: 'user', uuid: 'new-1' }])
    await sdkAppend(a, key, [{ type: 'assistant', uuid: 'new-2' }, { type: 'custom-title', title: 'u' }])
    // 4 old + 3 new; new-2 is entry 5 of the whole transcript (0-based), not entry 1 of this run's.
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 2, repaired: 0, main: { mainEntries: 7, lastUuid: 'new-2', lastUuidIndex: 5 } })
  })

  it("a run whose new entries carry no uuid: the last uuid is the earlier run's, at its index in the store", async () => {
    const egress = fakeEgress()
    egress.parts.set(
      JSON.stringify([key.projectKey, key.sessionId, null]),
      new Map<string, unknown[]>([['000000000000001-000000', [{ type: 'user', uuid: 'old-1' }, { type: 'assistant', uuid: 'old-2' }]]]),
    )
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, key, [{ type: 'custom-title', title: 'a' }, { type: 'custom-title', title: 'b' }])
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 0, repaired: 0, main: { mainEntries: 4, lastUuid: 'old-2', lastUuidIndex: 1 } })
  })

  it('a run that wrote two main transcripts fails the check', async () => {
    const egress = fakeEgress()
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, key, [{ type: 'user', uuid: 'a' }])
    await sdkAppend(a, { ...key, sessionId: '00000000-0000-4000-8000-000000000001' }, [{ type: 'user', uuid: 'b' }])
    expect(await a.checkpoint()).toEqual({ ok: false, error: 'this run wrote two main transcripts', repaired: 0 })
  })

  it('a run that wrote only a subagent transcript has no main state', async () => {
    const egress = fakeEgress()
    const a = createStoreAdapter({ fetch: egress.fetch, proxyUrl: PROXY_URL })
    await sdkAppend(a, { ...key, subpath: 'subagents/agent-1' }, [{ type: 'user', uuid: 's' }])
    expect(await a.checkpoint()).toEqual({ ok: true, entries: 1, repaired: 0, main: null })
  })

  it('load returns null for a key never written', async () => {
    const a = createStoreAdapter({ fetch: fakeEgress().fetch, proxyUrl: PROXY_URL })
    expect(await a.store.load(key)).toBeNull()
  })
})

describe('partId', () => {
  it.prop([fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 1, max: 3 })), { minLength: 2, maxLength: 50 })])(
    'parts sort in append order while the clock and the counter move forward',
    (steps) => {
      let t = 1_763_500_000_000
      let n = 0
      const ids = steps.map(([dt, dn]) => partId((t += dt), (n += dn)))
      expect([...ids].sort()).toEqual(ids)
      for (const id of ids) expect(id).toMatch(/^[0-9]{15}-[0-9]{6}$/)
    },
  )
})
