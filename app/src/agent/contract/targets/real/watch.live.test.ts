// The real client's P4 methods against the test build (W6, p4-w6.md section 5): every value parsed through the shared schema,
// the optimistic rollback on a forced failure, and fast-check over revision sequences for each `ifRev` method (a routine's
// switch, delete and restore, a Library file's delete and restore). It needs the test build under `wrangler dev`
// (CONTRACT_REAL_ORIGIN, run through e2e/support/test-build/serve.ts, the multi-config build for the routines' Run now): without
// an origin the whole file skips. The expected values are the design's: a fresh write lands and raises the rev by one; a stale
// one never applies and answers the record as it is now, with a higher rev.
import { fc, test as fcTest } from '@fast-check/vitest'
import { beforeAll, describe, expect, inject, it } from 'vitest'
import { ActivityPageSchema } from '../../../../../shared/contract/activity'
import { LibraryPageSchema } from '../../../../../shared/contract/files'
import { NotificationsListSchema } from '../../../../../shared/contract/notifications'
import { RoutinesListSchema } from '../../../../../shared/contract/routines'
import { TodayAnswerSchema } from '../../../../../shared/contract/today'
import { HttpAgent } from '../../../http/client'
import { AgentError } from '../../../types'
import { WATCH_READ_PATH, changeRoutineElsewhere, resetRoutines, seedUnreadNotice, settleRuns, settleTick, watchBuild, watchRoute } from './watch'
import { signer } from './me'
import { resetTeam } from './members'
import type { Signer } from './me'

const origin = inject('contractRealOrigin')
const MORNING_CHECK = 'routine-morning-check'
// The cases that need a Run now to end (a Today card comes from a morning check run) need the multi-config build with containers
// (the orchestrator's E2E_WATCH_BUILD=1). A containerless build (CI's contract step) runs only what it can serve, and says so.
const watch = watchBuild()
if (origin && !watch) console.warn('WATCH CONTRACT CASES SKIPPED in watch.live.test.ts: E2E_WATCH_BUILD is not 1, so the set-aside property and rollback (they need a morning check run, which needs a container) do not run')

describe.skipIf(!origin)('the real client\'s P4 methods', () => {
  // Built when the first test starts, not when the file is read: the signer needs the test build's key in the environment.
  let s: Signer
  const agentFor = (fetchOver?: typeof fetch) => new HttpAgent({ origin, fetch: fetchOver ?? ((i, init) => fetch(i, init)), headers: s.headers('admin') })
  const loaded = async (fetchOver?: typeof fetch) => { const a = agentFor(fetchOver); await a.whenLoaded(); return a }
  /** The routine as the server has it (the client's `read()` drops a deleted one): its rev, whether it is deleted, and its switch. */
  const server = async () => {
    // A restore or a switch pokes the routine tick, which moves the routine cursor in the background: let it finish before the next read/write (watch.ts settleTick).
    await settleTick()
    const r = await s.api('admin', 'GET', WATCH_READ_PATH.routines!)
    const list = r.json as { routines: { id: string; rev: number }[]; deleted: { id: string; rev: number }[]; enabled: Record<string, boolean> }
    const live = list.routines.find(x => x.id === MORNING_CHECK)
    const gone = list.deleted.find(x => x.id === MORNING_CHECK)
    const rec = live ?? gone
    if (!rec) throw new Error(`the server lists no ${MORNING_CHECK}`)
    return { rev: rec.rev, deleted: live === undefined, on: list.enabled[MORNING_CHECK] !== false }
  }
  /** A Today card to set aside: the first on Today, made by a morning check run when there is none (the scripted scenario fills it). */
  const todayItem = async (): Promise<string> => {
    const first = async () => ((await s.api('admin', 'GET', '/api/today')).json as { items: { id: string }[] }).items[0]?.id
    let id = await first()
    if (id === undefined) {
      await settleRuns()
      const run = await s.api('admin', 'POST', `/api/routines/${MORNING_CHECK}/run`, { clientKey: crypto.randomUUID().replaceAll('-', '') })
      if (run.status !== 200) throw new Error(`Run now on the morning check answered ${run.status}: ${JSON.stringify(run.json)}`)
      await settleRuns()
      id = await first()
    }
    if (id === undefined) throw new Error('Today holds no card after a morning check run: the scripted morning-check route (test/scripted-model/routes.ts) must be on')
    return id
  }
  /** The set-aside record of a card on the server: its reason and rev (0: none). */
  const asideOf = async (id: string) => {
    const r = ((await s.api('admin', 'GET', '/api/today')).json as { aside: Record<string, { reason: string | null; rev: number }> }).aside[id]
    return { reason: r?.reason ?? null, rev: r?.rev ?? 0 }
  }

  /** A second session of the person, by the API: each write sends the rev the server has now and must land (a refusal throws, naming it). */
  const asOther = {
    routine: {
      async deleteRoutine(id: string) { const r = await server(); const d = await s.api('admin', 'POST', `/api/routines/${id}/delete`, { ifRev: r.rev }); if (d.status !== 200) throw new Error(`delete answered ${d.status}: ${JSON.stringify(d.json)}`) },
      async restoreRoutine(id: string) { const r = await server(); const d = await s.api('admin', 'POST', `/api/routines/${id}/restore`, { ifRev: r.rev }); if (d.status !== 200) throw new Error(`restore answered ${d.status}: ${JSON.stringify(d.json)}`) },
    },
    async files(id: string, to: 'delete' | 'restore') {
      const list = ((await s.api('admin', 'GET', `/api/library${to === 'restore' ? '?deleted=1' : ''}`)).json as { items: { id: string; rev: number }[] }).items.find(f => f.id === id)
      if (!list) throw new Error(`the Library lists no ${id} to ${to}`)
      const d = await s.api('admin', 'POST', `/api/library/${to}`, { items: [{ id, ifRev: list.rev }] })
      if (d.status !== 200) throw new Error(`${to} answered ${d.status}: ${JSON.stringify(d.json)}`)
    },
    async aside(id: string, reason: 'snoozed' | null) {
      const d = await s.api('admin', 'PUT', `/api/today/${id}/aside`, { reason, ifRev: (await asideOf(id)).rev })
      if (d.status !== 200) throw new Error(`set aside answered ${d.status}: ${JSON.stringify(d.json)}`)
    },
  }

  beforeAll(async () => {
    s = signer(origin)
    // Every write here is the seeded Admin's. The contract suite that runs before this file on the same build (its
    // properties change roles at random, and its reset runs before each case, not after the last) can leave that person a
    // Member, and then a routine write answers forbidden/not_owner. Put the team back first, as the suite's own reset does.
    await resetTeam(s)
    if (watch) await settleRuns()
    await resetRoutines(s)
    await seedUnreadNotice()
  })

  describe('every value is parsed through the shared schema', () => {
    const reads: [string, string, { parse(v: unknown): unknown }][] = [
      ['routines', WATCH_READ_PATH.routines!, RoutinesListSchema],
      ['activity', WATCH_READ_PATH.activity!, ActivityPageSchema],
      ['notifications', WATCH_READ_PATH.notifications!, NotificationsListSchema],
      ['library', WATCH_READ_PATH.library!, LibraryPageSchema],
      ['today', '/api/today', TodayAnswerSchema],
    ]
    for (const [name, path, schema] of reads) {
      it(`${name}: the answer of ${path} parses`, async () => {
        const r = await s.api('admin', 'GET', path)
        expect(r.status, JSON.stringify(r.json)).toBe(200)
        expect(() => schema.parse(r.json)).not.toThrow()
      })
    }
    it('the client\'s own state carries the same records: routines, notifications and files parse as the page reads them', async () => {
      const a = await loaded()
      expect(a.read().routines.length).toBeGreaterThan(0)
      for (const r of a.read().routines) expect(r.rev).toBeGreaterThanOrEqual(1)
      for (const f of a.listFiles()) expect(f.rev).toBeGreaterThanOrEqual(1)
    })
  })

  describe('a forced failure rolls the change back and leaves the snapshot as it was', () => {
    /** Answers 503 to the write `method` is about to send, once, and passes everything else on. */
    const failing = (method: string, args: unknown[]): typeof fetch => {
      const route = watchRoute(method, args)
      if (!route) throw new Error(`no route for ${method}`)
      let armed = true
      return async (input, init) => {
        const url = new URL(String(input), origin)
        if (armed && route.verbs.includes((init?.method ?? 'GET').toUpperCase()) && url.pathname === route.path) {
          armed = false
          return new Response(JSON.stringify({ error: { code: 'unavailable' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }
        return fetch(input, init)
      }
    }
    const refused = async (p: Promise<unknown>): Promise<AgentError> => {
      const e = await p.then(() => undefined, (x: unknown) => x)
      expect(e, 'the write rejects').toBeInstanceOf(AgentError)
      return e as AgentError
    }
    it('deleteRoutine, then setToggle of its switch, then runRoutine', async () => {
      const id = MORNING_CHECK
      for (const [method, args, call] of [
        ['deleteRoutine', [id], (a: HttpAgent) => a.deleteRoutine(id)],
        ['setToggle', [`r:${id}`, false], (a: HttpAgent) => a.setToggle(`r:${id}`, false)],
        ['runRoutine', [id], (a: HttpAgent) => a.runRoutine(id)],
      ] as const) {
        const a = await loaded(failing(method, [...args]))
        const before = a.getSnapshot()
        const e = await refused(call(a))
        expect(e.code, method).toBe('unavailable')
        expect(a.getSnapshot(), `${method} put the snapshot back`).toBe(before)
      }
    })
    it('deleteFiles and uploadFiles', async () => {
      const probe = await loaded()
      const id = probe.listFiles()[0]?.id
      if (id === undefined) await probe.uploadFiles([new File(['sku,qty\nA0,1\n'], 'watch live file.csv', { type: 'text/csv' })])
      const fileId = probe.listFiles()[0]!.id
      const a = await loaded(failing('deleteFiles', [[fileId]]))
      const before = a.getSnapshot()
      expect((await refused(a.deleteFiles([fileId]))).code).toBe('unavailable')
      expect(a.getSnapshot()).toBe(before)
      const b = await loaded(failing('uploadFiles', [[]]))
      const filesBefore = b.listFiles()
      expect((await refused(b.uploadFiles([new File(['x,1\n'], 'refused.csv', { type: 'text/csv' })]))).code).toBe('unavailable')
      expect(b.listFiles()).toBe(filesBefore)
    })
    it('restoreRoutine: the delete lands, the refused restore puts the routine back as deleted', async () => {
      const a = await loaded(failing('restoreRoutine', [MORNING_CHECK]))
      await a.deleteRoutine(MORNING_CHECK)
      const before = a.getSnapshot()
      expect(before.routinesDeleted[MORNING_CHECK]).toBe(true)
      expect((await refused(a.restoreRoutine(MORNING_CHECK))).code).toBe('unavailable')
      // A rollback builds a new state object: compared by value.
      expect(a.getSnapshot(), 'the refused restore put the snapshot back').toEqual(before)
      await resetRoutines(s)
    })
    it('restoreFiles: the delete lands, the refused restore leaves the file out of the list', async () => {
      const probe = await loaded()
      if (probe.listFiles().length === 0) await probe.uploadFiles([new File(['sku,qty\nA2,1\n'], 'watch live file.csv', { type: 'text/csv' })])
      const fileId = probe.listFiles()[0]!.id
      const a = await loaded(failing('restoreFiles', [[fileId]]))
      await a.deleteFiles([fileId])
      const before = a.getSnapshot()
      expect(a.listFiles().map(f => f.id)).not.toContain(fileId)
      expect((await refused(a.restoreFiles([fileId]))).code).toBe('unavailable')
      expect(a.getSnapshot(), 'the refused restore put the snapshot back').toEqual(before)
      await asOther.files(fileId, 'restore')
    })
    it.skipIf(!watch)('setAside: a refused snooze leaves the card where it was', async () => {
      const id = await todayItem()
      const a = await loaded(failing('setAside', [id]))
      const before = a.getSnapshot()
      expect((await refused(a.setAside(id, 'snoozed'))).code).toBe('unavailable')
      expect(a.getSnapshot()).toBe(before)
    })
    it('markNoticesRead (an unread notice is seeded in beforeAll: none is a failure)', async () => {
      const a = await loaded(failing('markNoticesRead', [[]]))
      const unread = a.listNotifications().filter(n => n.unread).map(n => n.id)
      expect(unread.length, 'the seeded unread notice is on the bell').toBeGreaterThan(0)
      const before = a.listNotifications()
      expect((await refused(a.markNoticesRead(unread))).code).toBe('unavailable')
      expect(a.listNotifications().map(n => [n.id, n.unread])).toEqual(before.map(n => [n.id, n.unread]))
    })
  })

  describe('fast-check over revision sequences', () => {
    const runs = { numRuns: 8 }
    const step = fc.record({ stale: fc.boolean(), toggle: fc.boolean() })

    fcTest.prop([fc.array(step, { minLength: 1, maxLength: 6 })], runs)(
      'a routine: a fresh switch, delete or restore lands and raises the rev by one; a stale one never applies, answers the current record (a higher rev) and leaves the state as it was',
      async steps => {
        await resetRoutines(s)
        const a = await loaded()
        let lastRev = (await server()).rev
        for (const { stale, toggle } of steps) {
          const before = await server()
          if (stale) {
            await changeRoutineElsewhere(asOther.routine, MORNING_CHECK, before.deleted)
          }
          // A deleted routine can only be restored; a live one is switched or deleted.
          const op = before.deleted ? () => a.restoreRoutine(MORNING_CHECK) : toggle ? () => a.setToggle(`r:${MORNING_CHECK}`, !before.on) : () => a.deleteRoutine(MORNING_CHECK)
          const e = await op().then(() => undefined, (x: unknown) => x)
          const after = await server()
          if (stale) {
            expect(e, 'a stale write rejects').toBeInstanceOf(AgentError)
            expect((e as AgentError).code).toBe('conflict')
            expect((e as AgentError).current, 'it returns the record as it is now').toBeTruthy()
            expect(after.rev, 'revisions only go up').toBeGreaterThan(lastRev)
            expect([after.deleted, after.on], 'it never applied').toEqual([before.deleted, before.on])
            expect(a.getSnapshot().routinesDeleted[MORNING_CHECK] === true, 'the client shows the server\'s state').toBe(before.deleted)
          } else {
            expect(e, 'a fresh write lands').toBeUndefined()
            expect(after.rev, 'a fresh write raises the rev by one').toBe(lastRev + 1)
            expect(a.getSnapshot().routinesDeleted[MORNING_CHECK] === true, 'the client shows what landed').toBe(after.deleted)
          }
          lastRev = after.rev
        }
      },
    )

    ;(watch ? fcTest : fcTest.skip).prop([fc.array(fc.boolean(), { minLength: 1, maxLength: 5 })], runs)(
      'a Today card\'s set-aside: a fresh snooze or undo lands and raises the rev by one; a stale one never applies, answers the current record (a higher rev) and leaves the reason as it was',
      async stales => {
        const id = await todayItem()
        const start = await asideOf(id)
        if (start.reason !== null) await s.api('admin', 'PUT', `/api/today/${id}/aside`, { reason: null, ifRev: start.rev })
        const a = await loaded()
        let lastRev = (await asideOf(id)).rev
        for (const stale of stales) {
          const before = await asideOf(id)
          if (stale) {
            // Two writes in the other session that leave the reason as it was, two revisions on.
            if (before.reason === null) { await asOther.aside(id, 'snoozed'); await asOther.aside(id, null) } else { await asOther.aside(id, null); await asOther.aside(id, 'snoozed') }
          }
          const hidden = a.getSnapshot().setAside[id] !== undefined
          const e = await (hidden ? a.setAside(id, null) : a.setAside(id, 'snoozed')).then(() => undefined, (x: unknown) => x)
          const after = await asideOf(id)
          if (stale) {
            expect(e, 'a stale write rejects').toBeInstanceOf(AgentError)
            expect((e as AgentError).code).toBe('conflict')
            expect(after.rev, 'revisions only go up').toBeGreaterThan(lastRev)
            expect(after.reason, 'it never applied').toBe(before.reason)
          } else {
            expect(e, 'a fresh write lands').toBeUndefined()
            expect(after.rev, 'a fresh write raises the rev by one').toBe(lastRev + 1)
            expect(after.reason === null, 'it flipped').toBe(!(before.reason === null))
          }
          lastRev = after.rev
        }
        const end = await asideOf(id)
        if (end.reason !== null) await s.api('admin', 'PUT', `/api/today/${id}/aside`, { reason: null, ifRev: end.rev })
      },
    )

    fcTest.prop([fc.array(fc.boolean(), { minLength: 1, maxLength: 5 })], runs)(
      'a Library file: a fresh delete lands (rev + 1) and a restore brings it back (rev + 1); a stale delete never applies and answers the file as it is',
      async stales => {
        const probe = await loaded()
        if (probe.listFiles().length === 0) await probe.uploadFiles([new File(['sku,qty\nA1,1\n'], 'watch live file.csv', { type: 'text/csv' })])
        const a = await loaded()
        const id = a.listFiles()[0]!.id
        const revOf = (x: HttpAgent) => x.listFiles().find(f => f.id === id)?.rev
        let lastRev = revOf(a)!
        for (const stale of stales) {
          if (stale) {
            await asOther.files(id, 'delete')
            await asOther.files(id, 'restore')
            const e = await a.deleteFiles([id]).then(() => undefined, (x: unknown) => x)
            expect(e, 'a stale delete rejects').toBeInstanceOf(AgentError)
            expect((e as AgentError).code).toBe('conflict')
            expect(revOf(a), 'the file is still listed, at the server\'s rev').toBeGreaterThan(lastRev)
            lastRev = revOf(a)!
          } else {
            await a.deleteFiles([id])
            expect(a.listFiles().map(f => f.id), 'a fresh delete lands').not.toContain(id)
            await a.restoreFiles([id])
            expect(revOf(a), 'a delete and a restore raise the rev by two').toBe(lastRev + 2)
            lastRev = revOf(a)!
          }
        }
      },
    )
  })
})
