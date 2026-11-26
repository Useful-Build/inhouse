// The Routines page over a fake `fetch` (P4 W2, routes 52 to 56, and route 86). Ways it could show a person the wrong thing, written
// down first:
//  - a routine's switch not read from the server (`r:<id>` missing), or lost when the settings reload;
//  - a switch, a delete or an Undo that the server refused left on screen; a stale rev not taken in from the conflict;
//  - a write sent with a rev older than the last answer's; a Run now sent with a key the route refuses (a ".");
//  - the Inhouse team asked for the list on start (a grant would log every read);
//  - route 86's answer taken in without its schema (a run id or an outcome off the list gets through).
import { describe, expect, test } from 'vitest'
import { HttpAgent } from './client'
import { me, reads, record, refusal, server } from './testing/fake-server'
import type { Req, Routes } from './testing/fake-server'

const NOW = Date.UTC(2026, 5, 1, 12)
const at = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const def = (id: string, rev = 1, o: Record<string, unknown> = {}) => ({
  id, name: `Routine ${id}`, what: 'Check stock.', freq: 'Daily', day: '', time: { hour: 6, minute: 0 }, next: at(NOW + 3_600_000), need: 1, canManage: true, rev, ...o,
})
const LAST = { at: at(NOW - 60_000), result: 'Found 3 things' }
const state = (r: Record<string, unknown>, enabled = true) => ({ routine: r, enabled })
const LIST = { routines: [def('rt_a', 1, { last: LAST }), def('rt_b', 2)], deleted: [def('rt_gone', 3)], enabled: { rt_a: true, rt_b: false, rt_gone: true } }

async function loaded(routes: Routes) {
  const s = server(routes)
  const agent = new HttpAgent({ fetch: s.fetch, now: () => NOW })
  await agent.whenLoaded()
  return { agent, ...s }
}
/** A client whose requests to `held` (and `alsoHeld`) wait until `release()` (`releaseAlso()`): writes still on their way. */
async function loadedHolding(routes: Routes, held: string, alsoHeld?: string) {
  const s = server(routes)
  let release!: () => void
  let releaseAlso!: () => void
  const gate = new Promise<void>(r => { release = r })
  const gateAlso = new Promise<void>(r => { releaseAlso = r })
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://x.test').pathname
    if (path === held) await gate
    if (path === alsoHeld) await gateAlso
    return s.fetch(input, init)
  }
  const agent = new HttpAgent({ fetch, now: () => NOW })
  await agent.whenLoaded()
  return { agent, release, releaseAlso, ...s }
}
const body = (r: Req) => JSON.parse(r.body ?? 'null') as Record<string, unknown>

describe('the client: routines', () => {
  test('boots with the list, each switch as an r: toggle, and the deleted ones marked', async () => {
    const { agent } = await loaded(reads({ routines: LIST }))
    expect(agent.read().routines.map(r => r.id)).toEqual(['rt_a', 'rt_b'])
    expect(agent.read().resources.routines).toEqual({ status: 'ready' })
    expect(agent.getSnapshot().toggles).toMatchObject({ 'r:rt_a': true, 'r:rt_b': false })
    expect(agent.getSnapshot().routinesDeleted).toEqual({ rt_gone: true })
  })

  test('a settings reload keeps the routines\' switches', async () => {
    const { agent } = await loaded({ ...reads({ routines: LIST }), 'GET /api/settings/technical': { body: { items: [record('t:tone', 'Plain and direct', 1)] } } })
    await agent.retry('meta')
    expect(agent.getSnapshot().toggles).toMatchObject({ 'r:rt_a': true, 'r:rt_b': false })
  })

  test('the switch: optimistic, sent with the routine\'s rev, the answer\'s rev used next', async () => {
    let n = 0
    const { agent, calls } = await loaded({ ...reads({ routines: LIST }), 'PUT /api/routines/rt_a/enabled': (r: Req) => ({ body: state(def('rt_a', (body(r).ifRev as number) + 1 + 0 * ++n), body(r).on as boolean) }) })
    const p = agent.setToggle('r:rt_a', false)
    expect(agent.getSnapshot().toggles['r:rt_a']).toBe(false)
    await p
    await agent.setToggle('r:rt_a', true)
    expect(calls.filter(c => c.method === 'PUT').map(body)).toEqual([{ on: false, ifRev: 1 }, { on: true, ifRev: 2 }])
    expect(agent.getSnapshot().toggles['r:rt_a']).toBe(true)
    // The answers carry no `last` here: the one on screen stays (H1).
    expect(agent.read().routines.find(r => r.id === 'rt_a')!.last).toEqual(LAST)
  })

  test('a refused switch comes back; a stale rev takes the routine and its switch as the server has them (L8)', async () => {
    const { agent } = await loaded({ ...reads({ routines: LIST }), 'PUT /api/routines/rt_a/enabled': refusal(409, 'conflict', { current: state(def('rt_a', 5), false) }) })
    await expect(agent.setToggle('r:rt_a', true)).rejects.toMatchObject({ code: 'conflict' })
    // The server says off now (someone switched it), whatever this client showed before.
    expect(agent.getSnapshot().toggles['r:rt_a']).toBe(false)
    expect(agent.read().routines.find(r => r.id === 'rt_a')!.rev).toBe(5)
    expect(agent.read().routines.find(r => r.id === 'rt_a')!.last).toEqual(LAST)
  })

  test('a plain refusal takes the switch back to what it was', async () => {
    const { agent } = await loaded({ ...reads({ routines: LIST }), 'PUT /api/routines/rt_a/enabled': refusal(403, 'forbidden', { reason: 'not_owner' }) })
    await expect(agent.setToggle('r:rt_a', false)).rejects.toMatchObject({ code: 'forbidden' })
    expect(agent.getSnapshot().toggles['r:rt_a']).toBe(true)
  })

  test('delete and Undo: optimistic, each with the rev the last answer left; Undo re-reads the list for its order', async () => {
    // The server's list after the restore (newest first: rt_a, then rt_b).
    let restored = false
    const { agent, calls } = await loaded({
      ...reads({ routines: LIST }),
      'GET /api/routines': () => ({ body: restored ? { routines: [def('rt_a'), def('rt_b', 4)], deleted: [def('rt_gone', 3)], enabled: { rt_a: true, rt_b: false, rt_gone: true } } : LIST }),
      'POST /api/routines/rt_b/delete': (r: Req) => ({ body: state(def('rt_b', (body(r).ifRev as number) + 1), false) }),
      'POST /api/routines/rt_b/restore': (r: Req) => { restored = true; return { body: state(def('rt_b', (body(r).ifRev as number) + 1), false) } },
    })
    const p = agent.deleteRoutine('rt_b')
    expect(agent.getSnapshot().routinesDeleted.rt_b).toBe(true)
    await p
    expect(agent.read().routines.map(r => r.id)).toEqual(['rt_a'])
    await agent.restoreRoutine('rt_b')
    expect(agent.getSnapshot().routinesDeleted.rt_b).toBeUndefined()
    expect(agent.read().routines.map(r => [r.id, r.rev])).toEqual([['rt_a', 1], ['rt_b', 4]])
    expect(calls.filter(c => c.method === 'POST').map(c => [c.path, body(c)])).toEqual([
      ['/api/routines/rt_b/delete', { ifRev: 2 }], ['/api/routines/rt_b/restore', { ifRev: 3 }],
    ])
  })

  test('a refused delete puts the routine back', async () => {
    const { agent } = await loaded({ ...reads({ routines: LIST }), 'POST /api/routines/rt_a/delete': refusal(403, 'forbidden', { reason: 'not_owner' }) })
    await expect(agent.deleteRoutine('rt_a')).rejects.toMatchObject({ code: 'forbidden' })
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBeUndefined()
  })

  test('a restore refused at the cap says why in the page\'s words and leaves the routine deleted (PR 312 review)', async () => {
    const { agent } = await loaded({ ...reads({ routines: LIST }), 'POST /api/routines/rt_gone/restore': refusal(403, 'forbidden', { reason: 'routine_limit' }) })
    const heard: unknown[] = []
    agent.onNotice(n => heard.push(n))
    await expect(agent.restoreRoutine('rt_gone')).rejects.toMatchObject({ code: 'forbidden', reason: 'routine_limit', message: 'This brand already has 50 routines. Delete one to restore this.' })
    expect(heard).toEqual([{ type: 'error', code: 'forbidden', text: 'This brand already has 50 routines. Delete one to restore this.' }])
    expect(agent.getSnapshot().routinesDeleted.rt_gone).toBe(true)
  })

  test('Run now sends a key the route takes, and the run heads routineRuns; run_open is refused in the page\'s words (L1), and a stage refusal no server sends any more gets no stage words (M2-I)', async () => {
    const run = { routine: 'rt_a', at: at(NOW) }
    const { agent, calls } = await loaded({
      ...reads({ routines: LIST }), 'POST /api/routines/rt_a/run': { body: run },
      'POST /api/routines/rt_b/run': refusal(409, 'conflict', { reason: 'run_open', current: run }),
      'POST /api/routines/rt_gone/run': refusal(403, 'forbidden', { reason: 'stage' }),
    })
    const heard: unknown[] = []
    agent.onNotice(n => heard.push(n))
    expect(await agent.runRoutine('rt_a')).toEqual(run)
    expect(agent.getSnapshot().routineRuns[0]).toEqual(run)
    expect(body(calls.find(c => c.path === '/api/routines/rt_a/run')!).clientKey).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    await expect(agent.runRoutine('rt_b')).rejects.toMatchObject({ code: 'conflict', reason: 'run_open', message: 'A run is still going. Try again when it finishes.' })
    // The product has no stages (Stage 1 M2-I): the server stopped sending this reason (M2-F), and the client no longer
    // words it. An old refusal is told as any refusal is, never with a stage's name.
    const stale = await agent.runRoutine('rt_gone').then(() => null, (e: unknown) => e)
    expect(stale).toMatchObject({ code: 'forbidden', reason: 'stage' })
    expect((stale as Error).message).not.toMatch(/\bstages?\b|\b(Watch|Act|Run)\b/i)
    expect(heard).toHaveLength(2)
    expect(heard[0]).toEqual({ type: 'error', code: 'conflict', text: 'A run is still going. Try again when it finishes.' })
    expect(heard[1]).toMatchObject({ type: 'error', code: 'forbidden' })
    expect((heard[1] as { text: string }).text).not.toMatch(/\bstages?\b|\b(Watch|Act|Run)\b/i)
    expect(agent.getSnapshot().routineRuns).toHaveLength(1)
  })

  test('Undo pressed while the delete is still on its way is a restore, sent after the delete answers with its rev (H2)', async () => {
    let restored = false
    const { agent, calls, release } = await loadedHolding({
      ...reads({ routines: LIST }),
      // The server's list once the restore landed (the Undo re-reads it).
      'GET /api/routines': () => ({ body: restored ? { ...LIST, routines: [def('rt_a', 3, { last: LAST }), def('rt_b', 2)] } : LIST }),
      'POST /api/routines/rt_a/delete': (r: Req) => ({ body: state(def('rt_a', (body(r).ifRev as number) + 1, { last: LAST })) }),
      'POST /api/routines/rt_a/restore': (r: Req) => { restored = true; return { body: state(def('rt_a', (body(r).ifRev as number) + 1, { last: LAST })) } },
    }, '/api/routines/rt_a/delete')
    const pDelete = agent.deleteRoutine('rt_a')
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBe(true)
    const pUndo = agent.restoreRoutine('rt_a')
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBeUndefined()
    release()
    await Promise.all([pDelete, pUndo])
    expect(calls.filter(c => c.method === 'POST').map(c => [c.path, body(c)])).toEqual([
      ['/api/routines/rt_a/delete', { ifRev: 1 }], ['/api/routines/rt_a/restore', { ifRev: 2 }],
    ])
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBeUndefined()
    expect(agent.read().routines.find(r => r.id === 'rt_a')).toMatchObject({ rev: 3, last: LAST })
  })

  test('Undo during an in-flight delete: the routine stays shown live while the restore is queued (no flicker)', async () => {
    let restored = false
    const routes: Routes = {
      ...reads({ routines: LIST }),
      'GET /api/routines': () => ({ body: restored ? { ...LIST, routines: [def('rt_a', 3, { last: LAST }), def('rt_b', 2)] } : LIST }),
      'POST /api/routines/rt_a/delete': (r: Req) => ({ body: state(def('rt_a', (body(r).ifRev as number) + 1, { last: LAST })) }),
      'POST /api/routines/rt_a/restore': (r: Req) => { restored = true; return { body: state(def('rt_a', (body(r).ifRev as number) + 1, { last: LAST })) } },
    }
    // Both held: the screen is looked at between the delete's answer and the restore's.
    const { agent, release, releaseAlso } = await loadedHolding(routes, '/api/routines/rt_a/delete', '/api/routines/rt_a/restore')
    const pDelete = agent.deleteRoutine('rt_a')
    const pUndo = agent.restoreRoutine('rt_a')
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBeUndefined()
    release()
    await pDelete
    // The delete has answered; the restore is still to come: the screen keeps the Undo's mark.
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBeUndefined()
    releaseAlso()
    await pUndo
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBeUndefined()
  })

  test('a delete refused while an Undo is queued: the routine shows live, one notice, no restore sent', async () => {
    const { agent, calls, release } = await loadedHolding({
      ...reads({ routines: LIST }),
      'POST /api/routines/rt_a/delete': refusal(403, 'forbidden', { reason: 'not_owner' }),
    }, '/api/routines/rt_a/delete')
    const heard: unknown[] = []
    agent.onNotice(n => heard.push(n))
    const pDelete = agent.deleteRoutine('rt_a')
    const pUndo = agent.restoreRoutine('rt_a')
    release()
    await expect(pDelete).rejects.toMatchObject({ code: 'forbidden' })
    await pUndo
    expect(agent.getSnapshot().routinesDeleted.rt_a).toBeUndefined()
    expect(agent.read().routines.map(r => r.id)).toContain('rt_a')
    expect(heard).toHaveLength(1)
    expect(calls.filter(c => c.path === '/api/routines/rt_a/restore')).toEqual([])
  })

  test('the Undo re-read keeps another routine\'s switch that is still on its way (L8)', async () => {
    const { agent, release } = await loadedHolding({
      ...reads({ routines: LIST }),
      'POST /api/routines/rt_gone/restore': (r: Req) => ({ body: state(def('rt_gone', (body(r).ifRev as number) + 1)) }),
      'PUT /api/routines/rt_b/enabled': (r: Req) => ({ body: state(def('rt_b', (body(r).ifRev as number) + 1), body(r).on as boolean) }),
    }, '/api/routines/rt_b/enabled')
    const pSwitch = agent.setToggle('r:rt_b', true)
    // The restore's re-read lists rt_b as off (the server hasn't had the switch yet): the switch on its way stays on screen.
    await agent.restoreRoutine('rt_gone')
    expect(agent.getSnapshot().toggles['r:rt_b']).toBe(true)
    release()
    await pSwitch
    expect(agent.getSnapshot().toggles['r:rt_b']).toBe(true)
  })

  test('the Inhouse team is not asked on start; a 403 without a grant is nothing to show', async () => {
    const staff = await loaded({ ...reads({ routines: LIST }), 'GET /api/me': { body: me({ role: 'inhouse' }) } })
    expect(staff.calls.map(c => c.path)).not.toContain('/api/routines')
    const refused = await loaded({ ...reads(), 'GET /api/me': { body: me({ role: 'inhouse' }) }, 'GET /api/routines': refusal(403, 'forbidden', { reason: 'grant_required' }) })
    await refused.agent.retry('routines')
    expect(refused.agent.read().resources.routines).toEqual({ status: 'ready' })
  })

  test('route 86: a routine\'s runs as the server said them; a refusal, or an answer off the schema, rejects', async () => {
    const runs = { runs: [{ at: at(NOW), outcome: 'done', result: 'Found 3 things', manual: false, trace: 'r_x' }] }
    const { agent, calls } = await loaded({
      ...reads({ routines: LIST }),
      'GET /api/routines/rt_a/runs': { body: runs },
      'GET /api/routines/rt_gone/runs': refusal(404, 'not_found'),
      'GET /api/routines/rt_b/runs': { body: { runs: [{ ...runs.runs[0], runId: 'r_x' }] } },
    })
    expect(await agent.routineRunHistory('rt_a')).toEqual(runs)
    await expect(agent.routineRunHistory('rt_gone')).rejects.toMatchObject({ code: 'not_found' })
    await expect(agent.routineRunHistory('rt_b')).rejects.toBeInstanceOf(Error)
    expect(calls.filter(c => c.path.endsWith('/runs')).map(c => [c.method, c.path])).toEqual([
      ['GET', '/api/routines/rt_a/runs'], ['GET', '/api/routines/rt_gone/runs'], ['GET', '/api/routines/rt_b/runs'],
    ])
  })
})
