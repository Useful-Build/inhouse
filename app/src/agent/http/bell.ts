// The bell over HTTP (routes 60 and 61): the signed-in person's notifications, and marking some read. No zod here
// (the entry's size budget, schemas.ts): the transport parses each answer; the caller builds the body from `Contract`.
import type { NotificationItem } from '../../../shared/contract/notifications'
import type { Contract, Transport } from './transport'

/** Route 60: the 50 newest notices this person may see, newest first, with their read state. */
export async function readNotifications(http: Transport): Promise<NotificationItem[]> {
  return (await http.call({ method: 'GET', path: '/api/notifications', schema: 'notifications' })).items
}

/** Route 61: marks the notices read (at most 100 ids; the server skips any this person can't see). */
export function postNoticesRead(http: Transport, k: Contract, ids: readonly string[]): Promise<unknown> {
  return http.call({ method: 'POST', path: '/api/notifications/read', schema: 'ack', json: k.BODIES.notificationsRead.parse({ ids }) })
}
