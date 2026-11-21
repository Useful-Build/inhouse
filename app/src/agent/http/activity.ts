// Activity over HTTP (route 59, `GET /api/activity?cursor&limit`): the server's lines, newest first, rendered there from
// their templates and member ids. The snapshot keeps them split in two, as `data.activity` does: today's, and the
// earlier ones, by the brand's local date (`g:tz`). No zod here (the entry's size budget): the transport parses the answer.
import { daysBefore } from '../../lib/format'
import type { Display } from '../../lib/format'
import type { ActivityPage } from '../../../shared/contract/activity'
import type { ActivityLine } from '../types'
import type { Transport } from './transport'

/** Lines per page. A page is a day's worth for a small team; the screen shows what's read, newest first. */
export const ACTIVITY_PAGE = 100

/** One page of lines (`cursor` is the previous page's `nextCursor`). */
export function readActivityPage(http: Transport, page: { cursor?: string; limit?: number } = {}): Promise<ActivityPage> {
  const q = new URLSearchParams()
  if (page.limit !== undefined) q.set('limit', String(page.limit))
  if (page.cursor !== undefined) q.set('cursor', page.cursor)
  const qs = q.toString()
  return http.call({ method: 'GET', path: qs ? `/api/activity?${qs}` : '/api/activity', schema: 'activityPage' })
}

/** The lines split by the brand's local date: today's, and every earlier day's. Order kept (newest first); a line dated after now counts as today. */
export function splitActivity(lines: readonly ActivityLine[], nowMs: number, d: Display): { today: ActivityLine[]; earlier: ActivityLine[] } {
  const today: ActivityLine[] = []
  const earlier: ActivityLine[] = []
  for (const l of lines) (daysBefore(l.at, nowMs, d) <= 0 ? today : earlier).push(l)
  return { today, earlier }
}
