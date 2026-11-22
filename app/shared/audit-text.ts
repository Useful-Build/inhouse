// What an audit line says (p2-design section 8): its `what` and `detail` from the action and its arguments, one function
// for the audit page and the CSV. People are named by their current name, looked up by member id (`name`); a member id
// nobody can name shows as "Former member". A setting shows its value only when the registry, as it is now, marks the
// key audit-safe (a line written under an older registry may hold a value a later one redacts); otherwise none.
import type { AuditArgs } from './contract/audit.ts'
import { settingLabel, settingSpec } from './contract/settings.ts'

export interface AuditText {
  what: string
  detail: string
}

const ROLE = { member: 'Member', admin: 'Admin' } as const
const REVIVE = { revived: 'restarted', not_quarantined: 'wasn’t stuck', not_found: 'not found' } as const
const PRIVACY_TOPIC = { 'customers/data_request': 'A customer asked for their data', 'customers/redact': 'A customer asked to be erased', 'shop/redact': 'The store asked to be erased' } as const

const ROUTE: Record<string, string> = {
  '/api/members': 'The team',
  '/api/members/:id/photo': "A member's photo",
  '/api/audit': 'The audit log',
  '/api/audit/export.csv': 'The audit log export',
  '/api/chats': 'The chat list',
  '/api/chats/:id': 'A chat',
  '/api/runs/active': 'The running answers',
  '/api/traces/:id': "An answer's steps",
  '/api/socket': 'A live answer',
  '/api/chats/:id/files': "A chat's files",
  '/api/files/:fileId': 'A file',
  '/api/memory': 'Memory',
  '/api/memory/brand/:id/forgotten': 'Team memory',
  // P4 (wave-4 PR0).
  '/api/routines': 'Routines',
  '/api/today': 'Today',
  '/api/activity': 'Activity',
  '/api/library': 'The Library',
  '/api/library/:id/download': 'A Library file',
  '/api/routines/:id/enabled': 'A routine',
  '/api/routines/:id/run': 'A routine',
  '/api/routines/:id/delete': 'A routine',
  '/api/routines/:id/restore': 'A routine',
  '/api/today/:id/aside': 'An item on Today',
  '/api/library/delete': 'The Library',
  '/api/library/restore': 'The Library',
}

/** P4: what a routine edit changed, in a fixed order whatever order the line lists them. */
const CHANGED = { instruction: 'instructions', schedule: 'schedule', missed: 'missed runs' } as const
const CHANGED_ORDER = ['instruction', 'schedule', 'missed'] as const
const NEED = ['Watch', 'Act', 'Run'] as const
const SET_ASIDE = { snoozed: 'snoozed an item on Today', dismissed: 'dismissed an item on Today', declined: 'declined an item on Today' } as const
/** P4: a Library file type, in words (the stored type is the sniffer's, from P3's list). */
const FILE_TYPE: Record<string, string> = {
  'application/pdf': 'PDF', 'image/png': 'PNG image', 'image/jpeg': 'JPEG image', 'image/webp': 'WebP image',
  'text/csv': 'CSV', 'text/plain': 'Text', 'text/markdown': 'Markdown', 'application/json': 'JSON',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Presentation',
}
const files = (n: number) => (n === 1 ? '1 file' : `${n} files`)
/** Bytes as the Library shows a size: B under 1 KB, else KB or MB with one decimal under 10. */
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const [n, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / (1024 * 1024), 'MB']
  return `${n < 10 ? (Math.floor(n * 10) / 10).toString() : Math.floor(n).toString()} ${unit}`
}

const hours = (h: number) => (h === 1 ? '1 hour' : `${h} hours`)

/** `name(id)`: the member's current name, or null when the id names no member. */
export function auditText(args: AuditArgs, name: (memberId: string) => string | null): AuditText {
  const who = (id: string) => name(id) ?? 'Former member'
  switch (args.action) {
    case 'member.invited': return { what: 'invited a member', detail: `${who(args.memberId)} as ${ROLE[args.role]}` }
    case 'member.reinvited': return { what: 'invited a member again', detail: `${who(args.memberId)} as ${ROLE[args.role]}` }
    case 'member.bound': return { what: 'joined the team', detail: args.replaces ? 'Signed in with a new account' : '' }
    case 'member.restored': return { what: 'rejoined the team', detail: '' }
    case 'member.role_changed': return { what: 'changed a role', detail: `${who(args.memberId)}: ${ROLE[args.from]} → ${ROLE[args.to]}` }
    case 'member.removed': return { what: 'removed a member', detail: who(args.memberId) }
    case 'inhouse.first_sign_in': return { what: 'signed in for the first time', detail: 'Inhouse team' }
    case 'setting.changed': {
      let value: string
      if (args.value === null) value = 'reset'
      else if (args.redacted || args.value === undefined || !settingSpec(args.key)?.auditSafe) value = 'changed (not shown)'
      else if (typeof args.value === 'boolean') value = args.value ? 'on' : 'off'
      else if (/^a:/.test(args.key) && args.value !== 'anyone') value = who(args.value)
      else value = args.value
      return { what: 'changed a setting', detail: `${settingLabel(args.key) ?? args.key}: ${value}` }
    }
    case 'photo.changed': return { what: 'changed their photo', detail: '' }
    case 'photo.removed': return { what: 'removed their photo', detail: '' }
    case 'grant.created': return { what: 'gave the Inhouse team access', detail: hours(args.hours) }
    case 'grant.ended': return { what: 'ended the Inhouse team’s access', detail: '' }
    case 'grant.expired': return { what: 'Inhouse team access ended', detail: 'Its time ran out' }
    case 'support.access': return { what: args.method === 'GET' ? 'looked at brand data' : 'changed brand data', detail: ROUTE[args.route] ?? args.route }
    case 'agent.paused': return { what: 'paused the agent', detail: '' }
    case 'agent.resumed': return { what: 'resumed the agent', detail: '' }
    case 'support.attach': return { what: 'watched a live answer', detail: '' }
    case 'memory.forgotten': return { what: 'forgot a team memory', detail: '' }
    case 'memory.restored': return { what: 'brought back a team memory', detail: 'It waits for an admin’s OK' }
    case 'ops_task_revive': return { what: 'restarted a stuck background task', detail: `${args.kind}: ${REVIVE[args.result]} (release job)` }
    // P4 (wave-4 PR0). Never a routine name, an instruction, a file name or an item title: the line holds none.
    case 'routine.created': return { what: 'set up a routine', detail: `Needs the ${NEED[args.need]} stage` }
    case 'routine.updated': return { what: 'changed a routine', detail: CHANGED_ORDER.filter(c => args.changed.includes(c)).map(c => CHANGED[c]).join(', ').replace(/^./, c => c.toUpperCase()) }
    case 'routine.enabled': return { what: args.on ? 'turned a routine on' : 'turned a routine off', detail: '' }
    case 'routine.deleted': return { what: 'deleted a routine', detail: '' }
    case 'routine.restored': return { what: 'brought back a routine', detail: '' }
    case 'routine.run_now': return { what: 'ran a routine now', detail: '' }
    case 'library.uploaded': return { what: 'added a file to the Library', detail: `${FILE_TYPE[args.contentType] ?? args.contentType}, ${size(args.bytes)}` }
    case 'library.deleted': return { what: 'deleted Library files', detail: files(args.fileIds.length) }
    case 'library.restored': return { what: 'brought back Library files', detail: files(args.fileIds.length) }
    case 'today.set_aside': return args.reason === null ? { what: 'put back an item on Today', detail: '' } : { what: SET_ASIDE[args.reason], detail: '' }
    case 'restore.confirmed': return { what: 'confirmed a restore from a backup', detail: `Approved by ${who(args.approvedBy)}` }
    case 'restore.member_placeholder': return { what: 'kept a former member’s history after a restore', detail: who(args.memberId) }
    // P8a F2. The topic only: the line never says whom a request was about.
    case 'privacy.requested': return { what: 'received a privacy request from Shopify', detail: args.parsed ? PRIVACY_TOPIC[args.topic] : `${PRIVACY_TOPIC[args.topic]} (couldn’t be read)` }
    case 'privacy.closed': return { what: 'closed a privacy request from Shopify', detail: `${PRIVACY_TOPIC[args.topic]} (release job)` }
  }
}
