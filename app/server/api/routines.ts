// Routes 52 to 56 (P4 W2, p4-w2.md section 9): the Routines page. brand_data: members, Admins and the Inhouse team under
// a live grant (the matrix decides, and writes Inhouse's `support.access` line). Switching, deleting and restoring is the
// creator's, an Admin's or Inhouse's (OC 5; part of each write's statement); Run now is anyone's. Every write is one
// `rev`-guarded batch with its audit and Activity lines (routines/store.ts); a write that the tick must see pokes it.
import { RoutineIdSchema } from '../../shared/contract/audit.ts'
import type { AgentErrorCode, Instant } from '../../shared/contract/common.ts'
import type { RoutineDef, RoutineRun } from '../../shared/contract/routine.ts'
import { RoutineEnabledInputSchema, RoutineRevInputSchema, RoutineRunAnswerSchema, RoutineRunInputSchema, RoutineStateSchema, RoutinesListSchema } from '../../shared/contract/routines.ts'
import { readBody, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import { apiError, apiJson } from '../http.ts'
import type { HandlerContext } from '../routes.ts'
import { freqAndDay } from '../routines/schedule.ts'
import { nextSlot } from '../routines/slots.ts'
import type { At, ListedOutcome, ListedRoutine } from '../routines/store.ts'
import { resultWords } from '../routines/store.ts'
import type { SlotRow } from '../routines/rows.ts'
import { systemDescription } from '../routines/prompts.ts'

/** How far ahead `next` looks: every schedule has a day within a week. */
const NEXT_WITHIN_MS = 8 * 86_400_000

const instant = (ms: number): Instant => ({ iso: new Date(ms).toISOString(), ms })

/** Who reads: whether they may switch, delete and restore any routine (an Admin, or Inhouse under its grant). */
interface Viewer { memberId: string; manageAll: boolean }

function viewerOf(c: Pick<ApiCtx, 'principal'>): Viewer | null {
  const p = c.principal
  if (p.kind === 'person') return { memberId: p.memberId, manageAll: p.role === 'admin' }
  if (p.kind === 'inhouse') return { memberId: p.memberId, manageAll: true }
  return null
}

/** A routine as the page shows it (`RoutineDef`): the schedule in words, its next run in the brand's zone, its last end. */
export function routineDef(r: ListedRoutine, tz: string, viewer: Viewer, nowMs: number): RoutineDef {
  const next = nextSlot(r, tz, nowMs, NEXT_WITHIN_MS)
  if (!next) throw new Error('routineDef: a schedule with no run in the next 8 days')
  const ended = r.last_state !== null && r.last_ended_at_ms !== null
  return {
    id: r.id,
    name: r.name,
    // A team routine's instruction, its first 200 characters; a system routine's fixed description (section 9).
    what: r.origin === 'system' ? systemDescription(r.prompt_ref) : r.instruction.slice(0, 200),
    ...freqAndDay(r.days_mask),
    time: { hour: r.hour, minute: r.minute },
    next: instant(next.dueAtMs),
    need: r.need as 0 | 1 | 2,
    ...(ended ? {
      last: {
        at: instant(r.last_ended_at_ms as number),
        result: resultWords({ state: r.last_state as SlotRow['state'], result_text: r.last_result_text, failure: r.last_failure, outcome: r.last_outcome, reason: r.last_reason }),
      },
    } : {}),
    canManage: viewer.manageAll || r.creator_id === viewer.memberId,
    rev: r.rev,
  }
}

/** The brand's zone, or the 503 when its stored value isn't one (the tick stops deciding then too; the signal is red). */
async function zoneOf(c: ApiCtx): Promise<string | Response> {
  const tz = await storesOf(c).routines.zone()
  return typeof tz === 'string' ? tz : apiError('unavailable')
}

const atOf = (c: ApiCtx): At => {
  const p = c.principal
  return { ...writer(c), ...(p.kind === 'inhouse' && p.grant ? { inhouseGrant: p.grant.id } : {}) }
}

/** Asks the tick to look now. A failure is logged and left: the heartbeat (at most 5 minutes) picks the write up. */
async function poke(c: HandlerContext): Promise<void> {
  try {
    await brandAgent(c.env).poke({ kind: 'routine-tick', id: 'routine-poke' })
  } catch (err) {
    console.error({ event: 'routine_poke_failed', error: err instanceof Error ? err.name : 'unknown' })
  }
}

const routineIdOf = (c: ApiCtx): string | null => (RoutineIdSchema.safeParse(c.params.id).success ? c.params.id : null)

/** A write's answer: the routine as it is now and its switch (`RoutineState`), its current copy on a stale `ifRev`, 404 or 403. */
function answerWrite(o: ListedOutcome, tz: string, viewer: Viewer, nowMs: number): Response {
  const state = (r: ListedRoutine) => RoutineStateSchema.parse({ routine: routineDef(r, tz, viewer, nowMs), enabled: r.enabled === 1 })
  if ('ok' in o) return apiJson(state(o.ok))
  if ('conflict' in o) return apiError('conflict', { current: state(o.conflict) })
  if (o.refused === 'not_found') return apiError('not_found')
  return apiError('forbidden', { reason: 'not_owner' })
}

/** Route 52, `GET /api/routines`: `{ routines, deleted }`, newest first. */
export async function listRoutines(c: HandlerContext): Promise<Response> {
  if (new URL(c.request.url).search !== '') return apiError('invalid')
  const viewer = viewerOf(c)
  if (!viewer) return apiError('forbidden')
  const tz = await zoneOf(c)
  if (tz instanceof Response) return tz
  const { live, deleted } = await storesOf(c).routines.list()
  return apiJson(RoutinesListSchema.parse({
    routines: live.map(r => routineDef(r, tz, viewer, c.nowMs)),
    deleted: deleted.map(r => routineDef(r, tz, viewer, c.nowMs)),
    enabled: Object.fromEntries([...live, ...deleted].map(r => [r.id, r.enabled === 1])),
  }))
}

/** Route 53, `PUT /api/routines/:id/enabled` `{ on, ifRev }`: on or off (a change moves its cursor to now). */
export async function setRoutineEnabled(c: HandlerContext): Promise<Response> {
  const viewer = viewerOf(c)
  if (!viewer) return apiError('forbidden')
  const id = routineIdOf(c)
  if (!id) return apiError('not_found')
  const body = await readBody(c.request, RoutineEnabledInputSchema)
  if ('error' in body) return body.error
  const tz = await zoneOf(c)
  if (tz instanceof Response) return tz
  const o = await storesOf(c).routines.setEnabled(id, body.ok.on, body.ok.ifRev, atOf(c))
  if ('ok' in o) await poke(c)
  return answerWrite(o, tz, viewer, c.nowMs)
}

/** Routes 55 and 56, `POST /api/routines/:id/delete` and `/restore` `{ ifRev }`. */
function revWrite(which: 'remove' | 'restore') {
  return async (c: HandlerContext): Promise<Response> => {
    const viewer = viewerOf(c)
    if (!viewer) return apiError('forbidden')
    const id = routineIdOf(c)
    if (!id) return apiError('not_found')
    const body = await readBody(c.request, RoutineRevInputSchema)
    if ('error' in body) return body.error
    const tz = await zoneOf(c)
    if (tz instanceof Response) return tz
    const o = await storesOf(c).routines[which](id, body.ok.ifRev, atOf(c))
    if ('ok' in o && which === 'restore') await poke(c)
    return answerWrite(o, tz, viewer, c.nowMs)
  }
}
export const deleteRoutine = revWrite('remove')
export const restoreRoutine = revWrite('restore')

/**
 * Route 54, `POST /api/routines/:id/run` `{ clientKey }`: one claimed Run now the tick submits (never here). The same key
 * again answers the same run; another open Run now of the routine is `conflict`/`run_open` with that run; a deleted
 * routine is 404; a team routine below its stage is `forbidden`/`stage`. A disabled routine may run (OC 10).
 */
export async function runRoutineNow(c: HandlerContext): Promise<Response> {
  if (!viewerOf(c)) return apiError('forbidden')
  const id = routineIdOf(c)
  if (!id) return apiError('not_found')
  const body = await readBody(c.request, RoutineRunInputSchema)
  if ('error' in body) return body.error
  const o = await storesOf(c).routines.runNow(id, body.ok.clientKey, atOf(c))
  const run = (s: SlotRow): RoutineRun => RoutineRunAnswerSchema.parse({ routine: s.routine_id, at: instant(s.claimed_at_ms) })
  if ('ok' in o) {
    await poke(c)
    return apiJson(run(o.ok))
  }
  if ('conflict' in o) return apiError('conflict', { reason: 'run_open', current: run(o.conflict) })
  if (o.refused === 'not_found') return apiError('not_found')
  if (o.refused === 'stage') return apiError('forbidden', { reason: 'stage' })
  if (o.refused === 'settings') return apiError(o.code as AgentErrorCode, o.reason === undefined ? {} : { reason: o.reason })
  return apiError('unavailable')
}
