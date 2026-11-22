// Today over HTTP (P4 W3, routes 57 and 58): what the morning check found, and setting an item aside. Plain request
// builders (no zod here: the entry's size budget); the transport parses every answer through the shared schema, and the
// client (client.ts) makes the set-aside optimistic, with its revisions (C6) and rollback (C3).
import type { TodayAnswer, TodayAside } from '../../../shared/contract/today'
import type { Contract, Transport } from './transport'

/** Route 57: the cards to show (set aside ones left out) and the records of every card of the shown run. */
export const readToday = (http: Transport): Promise<TodayAnswer> => http.call({ method: 'GET', path: '/api/today', schema: 'today' })

/** Route 58: a snooze, a dismissal or an Undo (`null`), against the record's rev (0: none yet). Answers the record. */
export const putAside = (http: Transport, k: Contract, id: string, reason: 'snoozed' | 'dismissed' | null, ifRev: number): Promise<TodayAside> =>
  http.call({ method: 'PUT', path: `/api/today/${encodeURIComponent(id)}/aside`, schema: 'todayAside', json: k.BODIES.todayAside.parse({ reason, ifRev }) })
