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
    case 'support.access': return { what: args.method === 'PUT' ? 'changed brand data' : 'looked at brand data', detail: ROUTE[args.route] ?? args.route }
    case 'agent.paused': return { what: 'paused the agent', detail: '' }
    case 'agent.resumed': return { what: 'resumed the agent', detail: '' }
    case 'support.attach': return { what: 'watched a live answer', detail: '' }
    case 'memory.forgotten': return { what: 'forgot a team memory', detail: '' }
    case 'memory.restored': return { what: 'brought back a team memory', detail: 'It waits for an admin’s OK' }
    case 'ops_task_revive': return { what: 'restarted a stuck background task', detail: `${args.kind}: ${REVIVE[args.result]}` }
  }
}
