// The Routines page over HTTP (routes 52 to 56, P4 W2): the list, a routine's switch, Run now, delete and restore. Plain
// request builders (no zod here: the entry's size budget); the transport parses every answer through the shared schema,
// and the client (client.ts) makes the writes optimistic. A routine's switch is the `r:<id>` toggle (`setToggle`).
import type { RoutineDef, RoutineRun } from '../../../shared/contract/routine'
import type { RoutinesList } from '../../../shared/contract/routines'
import type { Contract, Transport } from './transport'

const path = (id: string, what: string) => `/api/routines/${encodeURIComponent(id)}/${what}`

/** Route 52: every routine, the deleted ones apart, and each one's switch. */
export const readRoutines = (http: Transport): Promise<RoutinesList> => http.call({ method: 'GET', path: '/api/routines', schema: 'routines' })

/** Route 53: a routine's switch, against its `rev`. Answers the routine. */
export const setRoutineToggle = (http: Transport, k: Contract, id: string, on: boolean, ifRev: number): Promise<RoutineDef> =>
  http.call({ method: 'PUT', path: path(id, 'enabled'), schema: 'routine', json: k.BODIES.routineEnabled.parse({ on, ifRev }) })

/** A Run now's key: 32 hex characters, no `.` (the route's rule). */
export const newRunKey = (): string => crypto.randomUUID().replaceAll('-', '')

/** Route 54: one Run now, idempotent by `clientKey` (a retry sends the same key). */
export const postRoutineRun = (http: Transport, k: Contract, id: string, clientKey: string): Promise<RoutineRun> =>
  http.call({ method: 'POST', path: path(id, 'run'), schema: 'routineRun', json: k.BODIES.routineRun.parse({ clientKey }) })

/** Routes 55 and 56: delete or restore, against the routine's `rev`. Answers the routine. */
export const postRoutineRev = (http: Transport, k: Contract, id: string, what: 'delete' | 'restore', ifRev: number): Promise<RoutineDef> =>
  http.call({ method: 'POST', path: path(id, what), schema: 'routine', json: k.BODIES.routineRev.parse({ ifRev }) })
