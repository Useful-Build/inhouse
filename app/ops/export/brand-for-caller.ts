// "Export everything" for the person asking (route 95, P8a D): the brand's shared data, and nothing of another person's
// that the access matrix wouldn't show this caller. Interim default (master plan, standing decision 10: option 1,
// pending Wasim). C1's other two scopes stay as they were: `person` (one member's own export) and `brand` (the ops CLI's
// whole-brand export).
//
// Every `export: true` store in the registry declares here how this scope reads it (brand-for-caller.test.ts fails on a store
// with no policy, or a policy for a store that isn't exported), and `planExport` refuses a store it finds none for:
// - `whole`: every row or object; brand data the matrix shows every caller of route 95.
// - `rows`: D1 rows matching `where` (null: none for this caller), each optionally cut by `project`.
// - `own_objects`: R2 objects under the caller's own `<memberId>` pattern; a person only (the Inhouse team has none).
// - `own_chat_files`: R2 objects of the caller's own chats (`files/<chatId>/`); a person only.
//
// Chats: a person's own only (`ownerObject`: routes 22 and 24 give a person their own chats). The Inhouse team gets no
// chats here: the matrix lets them open a chat one request at a time under a grant, each one audited, but a bulk copy of
// every member's chats is more than that, so this export is stricter than the matrix there (and for other members'
// photos, which route 15 serves one at a time).
import { memberRecord } from '../../server/db/members.ts'
import type { MemberRow } from '../../server/db/members.ts'
import type { SqlValue } from '../../server/db/sql.ts'

/** Who asked: a person (an Admin) or the Inhouse team under a grant. Route 95's matrix row lets no one else through. */
export interface ExportCaller {
  kind: 'person' | 'inhouse'
  memberId: string
}

export interface RowFilter {
  where: string
  params: SqlValue[]
}

export type CallerPolicy =
  | { kind: 'whole'; why: string }
  | {
    kind: 'rows'
    why: string
    where: (caller: ExportCaller) => RowFilter | null
    project?: (row: Record<string, unknown>, caller: ExportCaller) => Record<string, unknown>
  }
  | { kind: 'own_objects'; why: string }
  | { kind: 'own_chat_files'; why: string }

const person = (c: ExportCaller): boolean => c.kind === 'person'
/** The caller's own chats, as a subquery on one parameter (their member id). */
export const OWN_CHATS = 'SELECT id FROM chats WHERE owner_id = ?'
const ownChatRows = (column: string) => (c: ExportCaller): RowFilter | null =>
  person(c) ? { where: `${column} IN (${OWN_CHATS})`, params: [c.memberId] } : null

/** One policy per `export: true` registry entry, by name. */
export const BRAND_FOR_CALLER: Readonly<Record<string, CallerPolicy>> = {
  // Route 3 (`memberRecord`): person rows only, with the Members page's fields. No sign-in subject, no Inhouse team or
  // service row.
  members: {
    kind: 'rows',
    why: 'route 3: person rows, memberRecord fields only',
    where: () => ({ where: "kind = 'person'", params: [] }),
    project: row => ({ ...memberRecord(row as unknown as MemberRow) }),
  },
  // Routes 9 and 11 (brand and technical settings, everyone); route 7 (personal) is the person's own only.
  settings: {
    kind: 'rows',
    why: "routes 9 and 11: the brand's settings; route 7: the caller's own personal settings",
    where: c => (person(c) ? { where: "owner = 'brand' OR owner = ?", params: [c.memberId] } : { where: "owner = 'brand'", params: [] }),
  },
  support_grants: { kind: 'whole', why: 'route 16: Admins and the Inhouse team read every grant' },
  audit_log: { kind: 'whole', why: 'routes 19 and 20: brand data, read whole' },
  'photos/': { kind: 'own_objects', why: "the caller's own photo only" },
  chats: {
    kind: 'rows',
    why: "routes 22 and 24 (ownerObject): the caller's own chats; none for the Inhouse team",
    where: c => (person(c) ? { where: 'owner_id = ?', params: [c.memberId] } : null),
  },
  chat_messages: { kind: 'rows', why: "the caller's own chats' messages", where: ownChatRows('chat_id') },
  tool_calls: { kind: 'rows', why: "the caller's own chats' tool calls", where: ownChatRows('chat_id') },
  chat_files: { kind: 'rows', why: "the caller's own chats' files", where: ownChatRows('chat_id') },
  'files/': { kind: 'own_chat_files', why: "the caller's own chats' file bytes" },
  usage_months: { kind: 'whole', why: 'route 42: the brand\'s spend' },
  usage_turns: { kind: 'whole', why: "route 42: the brand's spend by member" },
  // Route 43 shows active brand facts and the caller's own active facts; route 77 shows waiting brand facts to Admins
  // and the Inhouse team. A forgotten fact no route shows; another person's facts never.
  memories: {
    kind: 'rows',
    why: "routes 43 and 77: brand facts (active or waiting) and the caller's own active facts",
    where: c => (person(c)
      ? { where: "(scope = 'brand' AND status IN ('active', 'waiting')) OR (scope = 'person' AND owner_id = ? AND status = 'active')", params: [c.memberId] }
      : { where: "scope = 'brand' AND status IN ('active', 'waiting')", params: [] }),
  },
  activity_lines: { kind: 'whole', why: 'route 59: brand data' },
  routines: { kind: 'whole', why: 'route 52: brand data' },
  routine_slots: { kind: 'whole', why: 'route 86: brand data' },
  library_uploads: { kind: 'whole', why: 'route 62: brand data' },
  library_marks: { kind: 'whole', why: 'route 62: brand data' },
  'library/': { kind: 'whole', why: 'route 64: brand data' },
  today_items: { kind: 'whole', why: 'route 57: brand data' },
  today_aside: { kind: 'whole', why: 'route 57: brand data' },
  'deletion-log/': { kind: 'whole', why: 'member ids, keys and counts only, like the audit log' },
  // Route 80: everyone reads requests; the Inhouse team gets no requester id.
  team_requests: {
    kind: 'rows',
    why: 'route 80: every request; the Inhouse team without the requester id',
    where: () => ({ where: '1', params: [] }),
    project: (row, c) => {
      if (person(c)) return row
      const { requested_by: _by, ...rest } = row
      return rest
    },
  },
  brand_skills: { kind: 'whole', why: 'route 84: brand data' },
}
