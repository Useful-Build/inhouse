// The bell's writer (p4-w4 section 2). `addNotice` returns one `INSERT OR IGNORE` for the producer's own `DB.batch`
// (the id is the producer's and changes when what the notice says changes, so a repeat is one row). Notices store ids
// and fields, never a name; `body` only where the template's row allows it, never truncated.
import { z } from 'zod'
import { checkFields, TemplateError } from '../activity/fields.ts'
import type { FieldValues } from '../activity/fields.ts'
import { AgentNotificationSchema } from '../../shared/contract/notice.ts'
import { NOTICE_TEMPLATES } from './templates.ts'
import type { NoticeTemplate } from './templates.ts'

export type NoticeLink = z.infer<typeof AgentNotificationSchema>['link']

export interface NoticeInput {
  /** The producer's id: changes when what the notice says changes. */
  id: string
  audience: 'team' | 'admins' | 'member'
  /** The member for audience `'member'`, and only then. */
  audienceMemberId?: string
  template: string
  fields: FieldValues
  /** Plain text, only on a template whose row says `body: { max }`. */
  body?: string
  /** The member shown (their name and avatar), if any. */
  personId?: string
  icon: string
  waiting?: boolean
  link: NoticeLink
  atMs: number
}

const MEMBER_ID = /^m_[A-Za-z0-9_-]{1,64}$/
const LinkSchema = AgentNotificationSchema.shape.link

/** Throws a `TemplateError` for anything the rules don't allow, against `table` (tests pass their own). */
export function checkNotice(table: Readonly<Record<string, NoticeTemplate>>, n: NoticeInput): NoticeTemplate {
  const t = Object.hasOwn(table, n.template) ? table[n.template] : undefined
  if (!t) throw new TemplateError(`unknown notice template ${n.template}`)
  if (n.id.length === 0) throw new TemplateError('a notice needs an id')
  checkFields(n.template, t.fields, n.fields)
  if ((n.audience === 'member') !== (n.audienceMemberId !== undefined)) throw new TemplateError("audienceMemberId is required exactly when the audience is 'member'")
  for (const id of [n.audienceMemberId, n.personId]) if (id !== undefined && !MEMBER_ID.test(id)) throw new TemplateError('audienceMemberId and personId are member ids')
  if (n.body === undefined) {
    if (t.body) throw new TemplateError(`template ${n.template} needs a body`)
  } else {
    if (!t.body) throw new TemplateError(`template ${n.template} takes no body`)
    const length = [...n.body].length
    if (length < 1 || length > t.body.max) throw new TemplateError(`a body of template ${n.template} is 1 to ${t.body.max} code points`)
  }
  LinkSchema.parse(n.link)
  if (!Number.isSafeInteger(n.atMs)) throw new TemplateError('atMs must be an integer')
  return t
}

export function noticeInsert(db: D1Database, table: Readonly<Record<string, NoticeTemplate>>, n: NoticeInput): D1PreparedStatement {
  const t = checkNotice(table, n)
  return db
    .prepare(
      'INSERT OR IGNORE INTO notices (id, audience, audience_member_id, template, fields_json, body, icon, person_id, at_ms, waiting, link_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      n.id, n.audience, n.audienceMemberId ?? null, n.template, JSON.stringify(n.fields), n.body ?? null, n.icon, n.personId ?? null,
      n.atMs, n.waiting ? 1 : 0, JSON.stringify(n.link), t.source,
    )
}

export const addNotice = (db: D1Database, n: NoticeInput): D1PreparedStatement => noticeInsert(db, NOTICE_TEMPLATES, n)
