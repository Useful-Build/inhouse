// A notice as the bell shows it (p4-w4 revision 3.2): `text` and `who` from the template row, `person` from `person_id`
// through the members table. A pseudonymised or gone member reads "A former member" and gets no avatar. `body` is
// passed on as stored: plain text, which the client shows escaped.
import { fill, instantOf, nameOf } from '../activity/render.ts'
import { AgentNotificationSchema } from '../../shared/contract/notice.ts'
import type { NotificationItem } from '../../shared/contract/notifications.ts'
import type { NoticeRow } from './read.ts'
import { NOTICE_TEMPLATES } from './templates.ts'
import type { NoticeTemplate } from './templates.ts'

const LinkSchema = AgentNotificationSchema.shape.link

export function renderNotice(row: NoticeRow, names: ReadonlyMap<string, string>, table: Readonly<Record<string, NoticeTemplate>> = NOTICE_TEMPLATES): NotificationItem {
  const t = Object.hasOwn(table, row.template) ? table[row.template] : undefined
  if (!t) throw new Error(`unknown notice template ${row.template}`)
  const fields = JSON.parse(row.fields_json) as Record<string, string | number>
  const person = row.person_id === null ? null : names.get(row.person_id) ?? null
  // The {person} slot exists only when the row names a person (a template that needs one on a row without fails loud).
  const slots: Record<string, string> = row.person_id === null ? {} : { person: nameOf(row.person_id, names) }
  for (const [k, v] of Object.entries(fields)) slots[k] = String(v)
  const link = LinkSchema.parse(JSON.parse(row.link_json))
  return {
    id: row.id, icon: row.icon, text: fill(t.text, slots), who: fill(t.who, slots), ...(person === null ? {} : { person }),
    at: instantOf(row.at_ms), unread: row.unread === 1, ...(row.waiting === 1 ? { waiting: true } : {}), link,
    ...(row.body === null ? {} : { body: row.body }),
  }
}

