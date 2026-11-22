// The routine tools (agent-tools "4. Routines", p4-w2.md section 8): create, list, update, delete and run now, as the
// run's person. A routine's own run (`m_system`) may only list (OC 3). Names and descriptions are the registry's; inputs
// and answers are here. These handlers get only D1 (`ToolDeps`), so they can't poke the tick: a write is picked up by
// the heartbeat within 5 minutes, inside a slot's 10-minute on-time window and a Run now's 10-minute deadline.
import { z } from 'zod'
import { decodeCursor, encodeCursor } from '../../../db/handler-kit.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { brandFacts } from '../../../routines/brand.ts'
import type { BrandFacts } from '../../../routines/brand.ts'
import { hashId } from '../../../routines/keys.ts'
import type { RoutineRow } from '../../../routines/rows.ts'
import { DaysSchema, TimeSchema, daysMask, parseTime, scheduleWords } from '../../../routines/schedule.ts'
import { nextSlot, scheduledTime } from '../../../routines/slots.ts'
import { MAX_TEAM_ROUTINES, createRoutine, deleteRoutine, listRoutines, readRoutine, resultWords, runNow, updateRoutine } from '../../../routines/store.ts'
import type { At, UpdateOutcome } from '../../../routines/store.ts'
import { REASON } from '../../../../shared/contract/error-codes.ts'
import { answer, refusal, tool } from '../../server/tool.ts'
import type { InhouseToolName, ToolHandler, ToolResult, ToolScope } from '../../server/tool.ts'

const PAGE = 20
const NEXT_WITHIN_MS = 8 * 86_400_000

export const STAGE_TEXT = 'Routines you set up need the Act stage. Ask an admin to move to Act.'
export const NOT_ALLOWED_TEXT = 'Only the person who set it up or an admin can change it'
export const ROUTINE_LIMIT_TEXT = `This brand already has ${MAX_TEAM_ROUTINES} routines, the most it can have. Delete one on the Routines page, then try again.`
export const SYSTEM_INSTRUCTION_TEXT = "This routine is built in, so its instructions can't be changed. Its schedule and on/off can."
const IN_ROUTINE = refusal('forbidden', "A routine's own run can list routines but can't create, change, delete or run one. Say what you'd change in your summary instead.")
const NOT_FOUND = (id: string) => refusal('not_found', `No routine has routine_id "${id}". Use routine_list to find it, then try again.`)
const CONFLICT = refusal('conflict', 'That routine changed while you were working on it. Call routine_list to see it as it is now, then try again.')

const routineId = z.string().min(1).max(64).describe('The `routine_id` that `routine_create` or `routine_list` returned, like "rt_…".')
const days = DaysSchema.describe('"daily", "weekdays", or a list of days such as ["mon", "thu"].')
const time = TimeSchema.describe('The time of day it runs in the brand\'s time zone, 24-hour "HH:MM", such as "06:00".')
const missed = z.enum(['skip', 'catch_up']).describe('A run missed while the system was off: "skip" it (the default), or "catch_up" with one late run within 6 hours.')

const at = (scope: ToolScope): At => ({ actorId: scope.memberId, requestId: scope.requestId, nowMs: scope.nowMs })

/**
 * When it runs next as an ISO instant, or null (switched off, or the brand's zone can't be read). Pure: the zone is read
 * before any write, so a committed write is never answered with an error from a read after it.
 */
function nextIso(r: RoutineRow, tz: BrandFacts['tz'], nowMs: number): string | null {
  if (r.enabled !== 1) return null
  if (typeof tz !== 'string') return null
  const n = nextSlot(r, tz, nowMs, NEXT_WITHIN_MS)
  return n ? new Date(n.dueAtMs).toISOString() : null
}

const words = (r: RoutineRow) => scheduleWords(r.days_mask, scheduledTime(r))

function writeRefused(o: Exclude<UpdateOutcome, { ok: RoutineRow }>, id: string): ToolResult {
  if ('conflict' in o) return CONFLICT
  if (o.refused === 'not_found') return NOT_FOUND(id)
  if (o.refused === 'stage') return refusal('stage', STAGE_TEXT)
  if (o.refused === 'system_instruction') return refusal('system_instruction', SYSTEM_INSTRUCTION_TEXT)
  return refusal('not_allowed', NOT_ALLOWED_TEXT)
}

/** The routines area's handlers (composed in ../index.ts). */
export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = {
  routine_create: tool({
    input: z.object({
      name: z.string().trim().min(1).max(80).describe('A short name people will recognise, at most 80 characters.'),
      instruction: z.string().trim().min(1).max(4000).describe('What to do on each run, written so it works with no chat history (at most 4000 characters).'),
      days, time, missed: missed.optional(),
    }).strict(),
    async call(a, scope, deps) {
      if (scope.memberId === SYSTEM_MEMBER_ID) return IN_ROUTINE
      const { hour, minute } = parseTime(a.time)
      const made = await createRoutine(deps.db, { name: a.name, instruction: a.instruction, days_mask: daysMask(a.days), hour, minute, missed: a.missed ?? 'skip' }, at(scope), scope.chatId)
      if ('refused' in made) return made.refused === 'stage' ? refusal('stage', STAGE_TEXT) : refusal(REASON.routineLimit, ROUTINE_LIMIT_TEXT)
      const r = made.ok
      const next = nextIso(r, made.tz, scope.nowMs)
      return answer(`Set up "${r.name}": ${words(r)}.${next ? ` Next run: ${next}.` : ''} (routine_id: ${r.id})`, { routine_id: r.id, schedule: words(r), next })
    },
  }),

  routine_list: tool({
    input: z.object({
      cursor: z.string().min(1).max(200).optional().describe('The `next_cursor` an earlier call returned, for the next page.'),
    }).strict(),
    async call({ cursor }, scope, deps) {
      let after: { ms: number; id: string } | null = null
      if (cursor !== undefined) {
        const key = decodeCursor(cursor)
        const m = key === null ? null : /^(\d+):(.+)$/.exec(key)
        if (!m) return refusal('invalid', 'That cursor is not one routine_list returned. Call routine_list without it to start over.')
        after = { ms: Number(m[1]), id: m[2] }
      }
      const { tz } = await brandFacts(deps.db)
      const rows = await listRoutines(deps.db, after, PAGE + 1)
      const page = rows.slice(0, PAGE)
      const items = page.map(r => ({
        routine_id: r.id,
        name: r.name,
        schedule: words(r),
        enabled: r.enabled === 1,
        next: nextIso(r, tz, scope.nowMs),
        last: r.last_state === null ? null : {
          at: r.last_ended_at_ms === null ? null : new Date(r.last_ended_at_ms).toISOString(),
          result: resultWords({ state: r.last_state, result_text: r.last_result_text, failure: r.last_failure, outcome: r.last_outcome, reason: r.last_reason }),
        },
        // The chat that made it, only to the person who made it.
        ...(r.source_chat_id !== null && r.creator_id === scope.memberId ? { source_chat_id: r.source_chat_id } : {}),
      }))
      const last = page[page.length - 1]
      const next_cursor = rows.length > PAGE && last ? encodeCursor(`${last.created_at_ms}:${last.id}`) : null
      if (items.length === 0) return answer('No routines are set up.', { routines: [], next_cursor })
      const text = items.map(i => `- ${i.name}: ${i.schedule}${i.enabled ? '' : ' (off)'}${i.last ? `; last: ${i.last.result}` : ''} (routine_id: ${i.routine_id})`).join('\n')
      return answer(`${items.length} ${items.length === 1 ? 'routine' : 'routines'}:\n${text}`, { routines: items, next_cursor })
    },
  }),

  routine_update: tool({
    input: z.object({
      routine_id: routineId,
      instruction: z.string().trim().min(1).max(4000).optional().describe('The new instruction, written so it works with no chat history.'),
      days: days.optional(), time: time.optional(), missed: missed.optional(),
      enabled: z.boolean().optional().describe('false pauses it, true resumes it.'),
    }).strict(),
    async call(a, scope, deps) {
      if (scope.memberId === SYSTEM_MEMBER_ID) return IN_ROUTINE
      const r = await readRoutine(deps.db, a.routine_id)
      if (!r || r.deleted_at_ms !== null) return NOT_FOUND(a.routine_id)
      const { tz } = await brandFacts(deps.db)
      const t = a.time === undefined ? {} : parseTime(a.time)
      const o = await updateRoutine(deps.db, r.id, r.rev, {
        ...(a.instruction !== undefined ? { instruction: a.instruction } : {}),
        ...(a.days !== undefined ? { days_mask: daysMask(a.days) } : {}),
        ...t,
        ...(a.missed !== undefined ? { missed: a.missed } : {}),
        ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
      }, at(scope))
      if (!('ok' in o)) return writeRefused(o, a.routine_id)
      const u = o.ok
      const next = nextIso(u, tz, scope.nowMs)
      return answer(`"${u.name}" now runs ${words(u)}${u.enabled === 1 ? '' : ', switched off'}.${next ? ` Next run: ${next}.` : ''}`, {
        routine_id: u.id, schedule: words(u), enabled: u.enabled === 1, next,
      })
    },
  }),

  routine_delete: tool({
    input: z.object({ routine_id: routineId }).strict(),
    async call({ routine_id }, scope, deps) {
      if (scope.memberId === SYSTEM_MEMBER_ID) return IN_ROUTINE
      const r = await readRoutine(deps.db, routine_id)
      if (!r || r.deleted_at_ms !== null) return NOT_FOUND(routine_id)
      const o = await deleteRoutine(deps.db, r.id, r.rev, at(scope))
      if (!('ok' in o)) return writeRefused(o, routine_id)
      return answer(`Deleted "${r.name}". It won't run again; the Routines page can bring it back.`, { routine_id, deleted: true })
    },
  }),

  routine_run_now: tool({
    input: z.object({ routine_id: routineId }).strict(),
    async call({ routine_id }, scope, deps) {
      if (scope.memberId === SYSTEM_MEMBER_ID) return IN_ROUTINE
      // One Run now per routine per turn: a repeated call in the same turn answers the same run.
      const o = await runNow(deps.db, routine_id, await hashId('rn_', `${scope.turnId}|${routine_id}`), at(scope))
      if ('ok' in o) {
        return answer(`Started a run of this routine. It starts within a few minutes and its result shows on the Routines page.`, {
          routine_id, run: o.ok.slot_key, at: new Date(o.ok.claimed_at_ms).toISOString(),
        })
      }
      if ('conflict' in o) return refusal('run_open', 'A run is still going. Try again when it finishes.')
      if (o.refused === 'not_found') return NOT_FOUND(routine_id)
      if (o.refused === 'stage') return refusal('stage', STAGE_TEXT)
      return refusal('unavailable', "The routine can't run right now: the brand's settings don't allow a run. Tell the person and suggest they check Settings.")
    },
  }),
}
