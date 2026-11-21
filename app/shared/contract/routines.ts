// Routes 52 to 56 (P4 W2, p4-w2.md section 9): the Routines page over HTTP. Request and response schemas, strict, parsed at
// the boundary both ways. A routine as the page shows it is `RoutineDef` (./routine.ts); a Run now's answer is `RoutineRun`.
import { z } from 'zod'
import { RoutineDefSchema, RoutineRunSchema } from './routine.ts'

/**
 * A Run now's client key: the turn key's shape with no `.`, so the run's slot key (`now|<routineId>|<clientKey>`) and its
 * end task id round-trip (server/routines/keys.ts `endTaskId` writes `|` as `.`). The server's `CLIENT_KEY` is this.
 */
export const ROUTINE_CLIENT_KEY = /^[A-Za-z0-9_-]{8,64}$/

/**
 * Route 52, `GET /api/routines`: the routines not deleted, and the deleted ones (for Undo), newest first. `enabled`: each
 * listed routine's switch by its id (the client keeps it as the `r:<id>` toggle).
 */
export const RoutinesListSchema = z.strictObject({
  routines: z.array(RoutineDefSchema),
  deleted: z.array(RoutineDefSchema),
  enabled: z.record(z.string(), z.boolean()),
})
export type RoutinesList = z.infer<typeof RoutinesListSchema>

/**
 * What routes 53, 55 and 56 answer (and a 409's `current`): the routine as it is now, and whether it's switched on (so a
 * refused switch can show the server's value).
 */
export const RoutineStateSchema = z.strictObject({ routine: RoutineDefSchema, enabled: z.boolean() })
export type RoutineState = z.infer<typeof RoutineStateSchema>

/** Route 53, `PUT /api/routines/:id/enabled`: on or off, against the routine's `rev`. Answers `RoutineState`. */
export const RoutineEnabledInputSchema = z.strictObject({ on: z.boolean(), ifRev: z.number().int().min(1) })
export type RoutineEnabledInput = z.infer<typeof RoutineEnabledInputSchema>

/** Route 54, `POST /api/routines/:id/run`: a Run now, idempotent by `clientKey`. Answers `RoutineRun` (no trace yet). */
export const RoutineRunInputSchema = z.strictObject({ clientKey: z.string().regex(ROUTINE_CLIENT_KEY) })
export type RoutineRunInput = z.infer<typeof RoutineRunInputSchema>
export const RoutineRunAnswerSchema = RoutineRunSchema

/** Routes 55 and 56, `POST /api/routines/:id/delete` and `/restore`: against the routine's `rev`. Answer `RoutineState`. */
export const RoutineRevInputSchema = z.strictObject({ ifRev: z.number().int().min(1) })
export type RoutineRevInput = z.infer<typeof RoutineRevInputSchema>
