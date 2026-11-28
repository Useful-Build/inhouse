// The connections index and the gateway's prepare, list and remove (Stage 1 M4-R1, N35), over in-memory objects.
// Ways it could go wrong, written first: the index written before the record (a crash between them lists an id whose
// object holds nothing: N53's plant); parallel prepares passing the cap of 20; a prepare racing a remove leaving a
// removed connection listed for good; a crash leaving something listed that a remove can't clear; a removed slug
// prepared again with its generation starting over (N53's plant: "a generation reused after remove and prepare").
import { describe, expect, it } from 'vitest'
import { fc, test } from '@fast-check/vitest'
import { CONNECTION_CAPS } from '../index/contract'
import { createMcpFixtures } from '../../test/upstreams/mcp/index'
import { getConnection, listConnections, prepareConnection, removeConnection } from './gateway'
import { INDEX_OBJECT } from './index'
import { isStoredConnection } from './record'
import { binding, ConnWorld, inhouse, server } from './testing/kit'

const world = () => new ConnWorld(createMcpFixtures().fetch)
const prep = (w: ConnWorld, slug: string, b = binding()) => prepareConnection(w.deps(), server, { actor: inhouse, slug, adminMaySignIn: false, binding: b })
const remove = (w: ConnWorld, slug: string) => removeConnection(w.deps(), server, { actor: inhouse, accountId: `mcp:${slug}` })
const listedIds = (w: ConnWorld) => (w.core(INDEX_OBJECT).indexList() as Promise<{ ok: true; value: { accountId: string }[] }>).then(r => r.value.map(e => e.accountId))
const liveIds = (w: ConnWorld) => [...w.stores.keys()].filter(id => id !== INDEX_OBJECT).filter(id => {
  const raw = w.raw(id)
  return isStoredConnection(raw) && !raw.removed
}).sort()

/** The index's invariant at any moment: every listed id's object holds a v3 record (live, or a tombstone a remove clears). */
async function everyListedHasARecord(w: ConnWorld): Promise<void> {
  for (const id of await listedIds(w)) expect(isStoredConnection(w.raw(id)), `${id} is listed with no record`).toBe(true)
}

describe('prepare, list, remove', () => {
  it('prepare writes the record, then the index; list shows it; remove tombstones it, then unlists it', async () => {
    const w = world()
    const p = await prep(w, 'helpdesk')
    expect(p).toMatchObject({ ok: true, value: { accountId: 'mcp:helpdesk', generation: 1, policyRev: 1, trusted: false, state: 'needs_review', paused: false } })
    const order = w.calls.filter(c => c.endsWith('.prepareConnection') || c.endsWith('.indexAdd'))
    expect(order).toEqual(['mcp:helpdesk.prepareConnection', `${INDEX_OBJECT}.indexAdd`])
    const listed = await listConnections(w.deps(), server)
    expect(listed.ok && listed.value.map(c => c.accountId)).toEqual(['mcp:helpdesk'])
    expect(await remove(w, 'helpdesk')).toEqual({ ok: true, value: { revoked: true } })
    const removeOrder = w.calls.filter(c => c.endsWith('.removeConnection') || c.endsWith('.indexRemove'))
    expect(removeOrder).toEqual(['mcp:helpdesk.removeConnection', `${INDEX_OBJECT}.indexRemove`])
    expect(await listConnections(w.deps(), server)).toEqual({ ok: true, value: [] })
    expect(w.raw('mcp:helpdesk')).toMatchObject({ v: 3, removed: true, reason: 'removed', generation: 2 })
    expect(await getConnection(w.deps(), server, { actor: inhouse, accountId: 'mcp:helpdesk' })).toMatchObject({ ok: false, error: { code: 'unknown_tool' } })
  })

  it('a removed slug is never prepared again, and its generation never goes back', async () => {
    const w = world()
    await prep(w, 'helpdesk')
    await remove(w, 'helpdesk')
    const again = await prep(w, 'helpdesk')
    expect(again).toMatchObject({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: slug_removed' } })
    expect(w.raw('mcp:helpdesk')).toMatchObject({ removed: true, generation: 2 })
    expect(await listedIds(w)).toEqual([])
  })

  it('the same prepare twice is one connection; another binding on a prepared slug is refused', async () => {
    const w = world()
    const a = await prep(w, 'helpdesk')
    const b = await prep(w, 'helpdesk')
    expect(b).toEqual(a)
    expect(await prep(w, 'helpdesk', binding(undefined, { path: 'key' }))).toMatchObject({ ok: false, error: { message: 'invalid arguments: exists' } })
    expect(await listedIds(w)).toEqual(['mcp:helpdesk'])
  })

  it('20 connections a brand: the 21st is refused and lists nothing', async () => {
    const w = world()
    for (let i = 0; i < CONNECTION_CAPS.perBrand; i++) expect((await prep(w, `tool${i}`)).ok).toBe(true)
    expect(await prep(w, 'onemore')).toMatchObject({ ok: false, error: { message: 'invalid arguments: connections_cap' } })
    expect((await listedIds(w)).length).toBe(CONNECTION_CAPS.perBrand)
    expect(w.raw('mcp:onemore')).toBeUndefined()
  })

  it('a listed connection whose object is broken or missing is skipped; the list still answers', async () => {
    const w = world()
    await prep(w, 'good')
    await prep(w, 'broken')
    w.store('mcp:broken').put('record', { v: 3, kind: 'mcp_runtime', accountId: 'mcp:broken', junk: true })
    await w.core(INDEX_OBJECT).indexAdd({ accountId: 'mcp:missing', slug: 'missing', generation: 1 })
    const listed = await listConnections(w.deps(), server)
    expect(listed.ok && listed.value.map(c => c.accountId)).toEqual(['mcp:good'])
  })
})

describe('the index under parallel prepares and removes', () => {
  test.prop([fc.scheduler(), fc.array(fc.tuple(fc.constantFrom('prepare', 'remove'), fc.integer({ min: 0, max: 24 })), { minLength: 1, maxLength: 40 })], { numRuns: 150 })(
    'never more than 20 listed; every listed id has a record at every step; once settled, listed is exactly the live records',
    async (s, ops) => {
      const w = world()
      w.around = async (_a, _m, call) => {
        await everyListedHasARecord(w)
        return s.schedule(Promise.resolve(), 'object call').then(call)
      }
      const running = ops.map(([op, n]) => (op === 'prepare' ? prep(w, `tool${n}`) : remove(w, `tool${n}`)))
      await s.waitFor(Promise.all(running))
      await everyListedHasARecord(w)
      const listed = await listedIds(w)
      expect(listed.length).toBeLessThanOrEqual(CONNECTION_CAPS.perBrand)
      expect(listed.sort()).toEqual(liveIds(w))
    },
  )

  test.prop([fc.scheduler()], { numRuns: 60 })('25 parallel prepares: exactly 20 listed, the rest abandoned and preparable again later', async s => {
    const w = world()
    w.around = (_a, _m, call) => s.schedule(Promise.resolve(), 'object call').then(call)
    const results = await s.waitFor(Promise.all(Array.from({ length: 25 }, (_, i) => prep(w, `tool${i}`))))
    expect(results.filter(r => r.ok).length).toBe(CONNECTION_CAPS.perBrand)
    expect((await listedIds(w)).length).toBe(CONNECTION_CAPS.perBrand)
    w.around = (_a, _m, call) => call()
    const refused = results.findIndex(r => !r.ok)
    const listedOne = (await listedIds(w))[0]!
    await remove(w, listedOne.slice(4))
    // Refused by the soft check (nothing written) or by the index (abandoned: a tombstone whose generation continues).
    const before = w.raw(`mcp:tool${refused}`) as { removed: true; reason: string; generation: number } | undefined
    if (before !== undefined) expect(before).toMatchObject({ removed: true, reason: 'abandoned' })
    const again = await prep(w, `tool${refused}`)
    expect(again).toMatchObject({ ok: true, value: { generation: (before?.generation ?? 0) + 1 } })
  })
})

describe('a crash between record and index', () => {
  /** Runs `op`, failing the `n`th object or index call (the call never runs: the isolate died before it). */
  async function crashAt(w: ConnWorld, n: number, op: () => Promise<unknown>): Promise<void> {
    let i = 0
    w.around = async (_a, _m, call) => {
      if (i++ === n) throw new Error('crash')
      return call()
    }
    await op().catch(() => undefined)
    w.around = (_a, _m, call) => call()
  }

  test.prop([fc.integer({ min: 0, max: 6 }), fc.boolean()], { numRuns: 60 })(
    'leaves nothing listed that a remove can\'t clear, and nothing listed without a record',
    async (n, removing) => {
      const w = world()
      if (removing) {
        await prep(w, 'helpdesk')
        await crashAt(w, n, () => remove(w, 'helpdesk'))
      } else {
        await crashAt(w, n, () => prep(w, 'helpdesk'))
      }
      await everyListedHasARecord(w)
      for (const id of await listedIds(w)) {
        expect(await removeConnection(w.deps(), server, { actor: inhouse, accountId: id })).toMatchObject({ ok: true })
      }
      expect(await listedIds(w)).toEqual([])
      // A remove that crashed is finished by the next; a prepare that crashed before its index write leaves at most an
      // unlisted record that holds no credential (the same prepare again lists it).
      if (removing) expect(liveIds(w)).toEqual([])
      for (const id of liveIds(w)) expect(w.raw(id)).toMatchObject({ key: null, client: null, token: null, refresh: null })
    },
  )

  it('a prepare that crashed before its index write is listed by the same prepare again', async () => {
    const w = world()
    w.around = async (_a, m, call) => {
      if (m === 'indexAdd') throw new Error('crash')
      return call()
    }
    await prep(w, 'helpdesk').catch(() => undefined)
    expect(await listedIds(w)).toEqual([])
    expect(w.raw('mcp:helpdesk')).toMatchObject({ removed: false, generation: 1 })
    w.around = (_a, _m, call) => call()
    expect(await prep(w, 'helpdesk')).toMatchObject({ ok: true, value: { generation: 1 } })
    expect(await listedIds(w)).toEqual(['mcp:helpdesk'])
  })
})
