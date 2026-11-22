// The bell's item over the wire (P4 W4). Ways it can fail: a body counted in UTF-16 units refuses a body the writer and the
// table accept (the writer counts code points up to 1,622; the table's CHECK counts characters up to 2,000), so one
// stored notice with emoji makes the whole list fail to parse.
import { describe, expect, it } from 'vitest'
import { NotificationItemSchema, NotificationsListSchema } from './notifications.ts'

const item = (body?: string) => ({ id: 'n', icon: 'x', text: 't', who: 'w', at: { iso: '1970-01-01T00:00:00.001Z', ms: 1 }, unread: true, link: { to: 'page', page: 'today' }, ...(body === undefined ? {} : { body }) })

describe('NotificationItemSchema.body counts code points', () => {
  it('accepts astral-plane text at the maximum and refuses one more, and an empty body', () => {
    expect(NotificationItemSchema.safeParse(item('😀'.repeat(2000))).success).toBe(true)
    expect(NotificationItemSchema.safeParse(item('😀'.repeat(2001))).success).toBe(false)
    expect(NotificationItemSchema.safeParse(item('')).success).toBe(false)
    expect(NotificationItemSchema.safeParse(item('a'.repeat(2000))).success).toBe(true)
    expect(NotificationItemSchema.safeParse(item('a'.repeat(2001))).success).toBe(false)
    expect(NotificationItemSchema.safeParse(item()).success).toBe(true)
  })
  it('a notify body of 1,622 emoji (the longest the writer takes) lists', () => {
    expect(NotificationsListSchema.safeParse({ items: [item('😀'.repeat(1622))] }).success).toBe(true)
  })
})
