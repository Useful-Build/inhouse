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
import { WATCH_READ_PATH, changeRoutineElsewhere, resetRoutines, watchRoute } from './watch'
import { signer } from './me'
import type { Signer } from './me'

const origin = inject('contractRealOrigin')
const MORNING_CHECK = 'routine-morning-check'

describe.skipIf(!origin)('the real client\'s P4 methods', () => {
  // Built when the first test starts, not when the file is read: the signer needs the test build's key in the environment.
  let s: Signer
  const agentFor = (fetchOver?: typeof fetch) => new HttpAgent({ origin, fetch: fetchOver ?? ((i, init) => fetch(i, init)), headers: s.headers('admin') })
  const loaded = async (fetchOver?: typeof fetch) => { const a = agentFor(fetchOver); await a.whenLoaded(); return a }
  /** The routine as the client holds it: its rev, and whether the page shows it deleted. */
  const routine = (a: HttpAgent) => ({ rev: a.read().routines.find(r => r.id === MORNING_CHECK)!.rev, deleted: a.getSnapshot().routinesDeleted[MORNING_CHECK] === true })

  beforeAll(async () => {
    s = signer(origin)
    await resetRoutines(s)
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
    it('markNoticesRead, when an unread notice exists', async ctx => {
      const a = await loaded(failing('markNoticesRead', [[]]))
      const unread = a.listNotifications().filter(n => n.unread).map(n => n.id)
      if (unread.length === 0) return ctx.skip()
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
        let lastRev = routine(a).rev
        for (const { stale, toggle } of steps) {
          const before = routine(a)
          const on = a.getSnapshot().toggles[`r:${MORNING_CHECK}`] !== false
          if (stale) {
            const other = await loaded()
            await changeRoutineElsewhere(other, MORNING_CHECK, before.deleted)
          }
          // A deleted routine can only be restored; a live one is switched or deleted.
          const op = before.deleted ? () => a.restoreRoutine(MORNING_CHECK) : toggle ? () => a.setToggle(`r:${MORNING_CHECK}`, !on) : () => a.deleteRoutine(MORNING_CHECK)
          const e = await op().then(() => undefined, (x: unknown) => x)
          const after = routine(a)
          if (stale) {
            expect(e, 'a stale write rejects').toBeInstanceOf(AgentError)
            expect((e as AgentError).code).toBe('conflict')
            expect((e as AgentError).current, 'it returns the record as it is now').toBeTruthy()
            expect(after.rev, 'revisions only go up').toBeGreaterThan(lastRev)
            expect(after.deleted, 'it never applied').toBe(before.deleted)
          } else {
            expect(e, 'a fresh write lands').toBeUndefined()
            expect(after.rev, 'a fresh write raises the rev by one').toBe(lastRev + 1)
          }
          lastRev = after.rev
        }
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
            const other = await loaded()
            await other.deleteFiles([id])
            await other.restoreFiles([id])
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
