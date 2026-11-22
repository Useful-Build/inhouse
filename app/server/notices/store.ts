// The bell's writer (p4-w4 section 2). `addNotice` returns one insert for the producer's own `DB.batch`
// (the id is the producer's and changes when what the notice says changes, so a repeat is one row; `ON CONFLICT (id)
// DO NOTHING`, not `OR IGNORE`, so a CHECK or NOT NULL failure still aborts the batch). Notices store ids
// and fields, never a name; `body` only where the template's row allows it, never truncated.
import { z } from 'zod'
import { checkFields, slotsOf, TemplateError } from '../activity/fields.ts'
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

const ID = /^[A-Za-z0-9_-]{1,64}$/
const MEMBER_ID = /^m_[A-Za-z0-9_-]{1,64}$/
const LinkSchema = AgentNotificationSchema.shape.link

function parseLink(link: unknown): NoticeLink {
  const parsed = LinkSchema.safeParse(link)
  if (!parsed.success) throw new TemplateError('the link is not a tool, page or chat link')
  const v = parsed.data
  const id = v.to === 'tool' ? v.key : v.to === 'chat' ? v.id : null
  if (id !== null && !ID.test(id)) throw new TemplateError('a link id is 1 to 64 letters, digits, _ or -')
  return v
}

/** Throws a `TemplateError` for anything the rules don't allow, against `table` (tests pass their own). Returns the template and the parsed link. */
export function checkNotice(table: Readonly<Record<string, NoticeTemplate>>, n: NoticeInput): { t: NoticeTemplate; link: NoticeLink } {
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
    if (n.body.includes('\0')) throw new TemplateError('a body can\'t hold a NUL')
    const length = [...n.body].length
    if (length < 1 || length > t.body.max) throw new TemplateError(`a body of template ${n.template} is 1 to ${t.body.max} code points`)
  }
  if (!['team', 'admins', 'member'].includes(n.audience)) throw new TemplateError('audience is team, admins or member')
  if (typeof n.icon !== 'string' || n.icon.length === 0) throw new TemplateError('a notice needs an icon')
  const personSlot = slotsOf(t.text).concat(slotsOf(t.who)).includes('person')
  if (personSlot !== (n.personId !== undefined)) throw new TemplateError(`template ${n.template} ${personSlot ? 'needs' : "doesn't take"} a personId`)
  if (!Number.isSafeInteger(n.atMs)) throw new TemplateError('atMs must be an integer')
  return { t, link: parseLink(n.link) }
}

/** The writer's statement, exported so a test can bind it directly against the table's CHECKs. */
export const NOTICE_INSERT_SQL =
  'INSERT INTO notices (id, audience, audience_member_id, template, fields_json, body, icon, person_id, at_ms, waiting, link_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING'

export function noticeInsert(db: D1Database, table: Readonly<Record<string, NoticeTemplate>>, n: NoticeInput): D1PreparedStatement {
  const { t, link } = checkNotice(table, n)
  return db
    .prepare(NOTICE_INSERT_SQL)
    .bind(
      n.id, n.audience, n.audienceMemberId ?? null, n.template, JSON.stringify(n.fields), n.body ?? null, n.icon, n.personId ?? null,
      n.atMs, n.waiting ? 1 : 0, JSON.stringify(link), t.source,
    )
}

export const addNotice = (db: D1Database, n: NoticeInput): D1PreparedStatement => noticeInsert(db, NOTICE_TEMPLATES, n)
