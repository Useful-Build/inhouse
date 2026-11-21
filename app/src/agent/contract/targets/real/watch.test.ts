import { describe, expect, it } from 'vitest'
import { WATCH_READ_PATH, WATCH_SERVED, changeRoutineElsewhere, resetRoutines, watchRoute } from './watch'
import type { Signer } from './me'

describe('the real target\'s P4 parts', () => {
  it('serves exactly these methods besides the Library five (literal)', () => {
    expect([...WATCH_SERVED]).toEqual(['runRoutine', 'deleteRoutine', 'restoreRoutine', 'markNoticesRead', 'listNotifications', 'setAside'])
  })
  it('reads each resource from the route the design numbers (literal)', () => {
    expect(WATCH_READ_PATH).toEqual({ routines: '/api/routines', activity: '/api/activity', notifications: '/api/notifications', library: '/api/library' })
  })
  it('sends each write to the route the design numbers (literal verbs and paths; ids are URL-encoded)', () => {
    expect(watchRoute('runRoutine', ['rt_a b'])).toEqual({ verbs: ['POST'], path: '/api/routines/rt_a%20b/run' })
    expect(watchRoute('deleteRoutine', ['routine-morning-check'])).toEqual({ verbs: ['POST'], path: '/api/routines/routine-morning-check/delete' })
    expect(watchRoute('restoreRoutine', ['routine-morning-check'])).toEqual({ verbs: ['POST'], path: '/api/routines/routine-morning-check/restore' })
    expect(watchRoute('setToggle', ['r:routine-morning-check', false])).toEqual({ verbs: ['PUT'], path: '/api/routines/routine-morning-check/enabled' })
    expect(watchRoute('markNoticesRead', [['n1']])).toEqual({ verbs: ['POST'], path: '/api/notifications/read' })
    expect(watchRoute('uploadFiles', [[]])).toEqual({ verbs: ['POST'], path: '/api/library/uploads' })
    expect(watchRoute('setAside', ['p_x', 'snoozed'])).toEqual({ verbs: ['PUT'], path: '/api/today/p_x/aside' })
  })
  it('leaves a setting\'s toggle and every other method to index.ts', () => {
    expect(watchRoute('setToggle', ['n:weekly', true])).toBeNull()
    expect(watchRoute('setSetting', ['k', 'v'])).toBeNull()
    expect(watchRoute('deleteFiles', [['f']])).toBeNull()
  })

  const fake = (state: { routines: { id: string; rev: number }[]; deleted: { id: string; rev: number }[]; enabled: Record<string, boolean> }, fail?: string) => {
    const calls: string[] = []
    const s = {
      api: async (_who: string, method: string, path: string, body?: { ifRev: number; on?: boolean }) => {
        calls.push(`${method} ${path} ${JSON.stringify(body ?? null)}`)
        if (fail === path) return { status: 409, json: { error: { code: 'conflict' } } }
        if (path === '/api/routines') return { status: 200, json: structuredClone(state) }
        const m = /^\/api\/routines\/([^/]+)\/(restore|enabled)$/.exec(path)
        if (!m) throw new Error(`unexpected ${method} ${path}`)
        const id = m[1]!
        if (m[2] === 'restore') {
          const at = state.deleted.findIndex(r => r.id === id)
          expect(body?.ifRev, 'restores against the rev the list showed').toBe(state.deleted[at]!.rev)
          state.routines.push({ id, rev: state.deleted[at]!.rev + 1 })
          state.deleted.splice(at, 1)
        } else {
          state.enabled[id] = body!.on!
          state.routines.find(r => r.id === id)!.rev++
        }
        return { status: 200, json: {} }
      },
    } as unknown as Signer
    return { s, calls }
  }

  it('resets the routines: every deleted one is restored, every switched-off one switched on, in that order', async () => {
    const { s, calls } = fake({ routines: [{ id: 'a', rev: 3 }, { id: 'b', rev: 2 }], deleted: [{ id: 'c', rev: 5 }], enabled: { a: true, b: false, c: true } })
    await resetRoutines(s)
    expect(calls.filter(c => !c.startsWith('GET'))).toEqual([
      'POST /api/routines/c/restore {"ifRev":5}',
      'PUT /api/routines/b/enabled {"on":true,"ifRev":2}',
    ])
  })
  it('does nothing to routines that are already live and on', async () => {
    const { s, calls } = fake({ routines: [{ id: 'a', rev: 1 }], deleted: [], enabled: { a: true } })
    await resetRoutines(s)
    expect(calls.every(c => c.startsWith('GET'))).toBe(true)
  })
  it('fails loud when a restore is refused', async () => {
    const { s } = fake({ routines: [], deleted: [{ id: 'c', rev: 5 }], enabled: {} }, '/api/routines/c/restore')
    await expect(resetRoutines(s)).rejects.toThrow(/restore routine c.*409/)
  })

  it('changes a routine elsewhere so it ends as it was: delete then restore when live, restore then delete when deleted', async () => {
    const seen: string[] = []
    const other = { deleteRoutine: async (id: string) => { seen.push(`delete ${id}`) }, restoreRoutine: async (id: string) => { seen.push(`restore ${id}`) } }
    await changeRoutineElsewhere(other, 'r1')
    await changeRoutineElsewhere(other, 'r2', true)
    expect(seen).toEqual(['delete r1', 'restore r1', 'restore r2', 'delete r2'])
  })
})
