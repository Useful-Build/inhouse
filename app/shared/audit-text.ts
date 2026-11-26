// What an audit line says (p2-design section 8): its `what` and `detail` from the action and its arguments, one function
// for the audit page and the CSV. People are named by their current name, looked up by member id (`name`); a member id
// nobody can name shows as "Former member". A setting shows its value only when the registry, as it is now, marks the
// key audit-safe (a line written under an older registry may hold a value a later one redacts); otherwise none.
import type { AuditArgs, RevokeReason } from './contract/audit.ts'
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
  '/api/routines/:id/runs': "A routine's runs",
  '/api/routines/:id/enabled': 'A routine',
  '/api/routines/:id/run': 'A routine',
  '/api/routines/:id/delete': 'A routine',
  '/api/routines/:id/restore': 'A routine',
  '/api/today/:id/aside': 'An item on Today',
  '/api/library/delete': 'The Library',
  '/api/library/restore': 'The Library',
  // P6a (PR0).
  '/api/memory/waiting': 'Team memory waiting for an OK',
  '/api/memory/brand/:id/approved': 'Team memory',
  // P6a brand skills (route 84).
  '/api/skills/:name': 'A skill',
  // P8a D (route 95).
  '/api/data-access/export': 'Export everything',
  // P8a D (route 96).
  '/api/data-access/export/check': 'The size of Export everything',
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

/** A connector account as the log names it: its connector's name (P5 W1). */
const CONNECTOR: Record<string, string> = { slack: 'Slack', shopify: 'Shopify' }
const connectorName = (accountId: string) => CONNECTOR[accountId.split(':')[0]!] ?? accountId
/** Why a connect didn't finish, in a few words; any other code shows as it is. */
const CONNECT_FAILED: Record<string, string> = {
  state_invalid: 'the link was used or expired',
  workspace_mismatch: 'another workspace was chosen',
  scope_mismatch: 'the permissions granted didn’t match',
  connect_stale: 'it was disconnected meanwhile',
  connect_refused: 'the provider refused',
  not_configured: 'it isn’t set up',
}

/** Why a notice didn't go, or where it went instead (P5 W4); any other code shows as it is. */
const NOTIFY_DETAIL: Record<string, string> = {
  not_listed: 'the channel isn’t listed',
  shared_channel: 'the channel is shared with another organization',
  archived: 'the channel is archived',
  not_public: 'the channel isn’t public',
  not_member: 'the connected person isn’t in the channel',
  not_found: 'the channel wasn’t found',
  run_cap: 'too many posts in one answer',
  day_cap: 'too many posts today',
  too_long: 'it was too long',
  empty: 'it was empty',
  unknown_member: 'not a member of the team',
  slack_not_connected: 'Slack isn’t connected or is paused',
  slack_unavailable: 'Slack couldn’t be reached',
  rate_limited: 'Slack asked to slow down',
  to_bell: 'sent to the bell until the Act stage',
  channel_to_bell: 'sent to the bell, not Slack',
  slack_off: 'Slack posts are off for now',
  no_alerts_channel: 'no alerts channel is set',
  below_act: 'Slack posts start at the Act stage',
  app_origin_missing: 'the app link isn’t set up at the hub',
}
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** P6a: a team request's kind, as the Inhouse team window names it. */
const REQUEST_KIND = { tool: 'New tool', job: 'New job', change: 'Change something', bug: 'Bug report', feedback: 'Feedback' } as const
const REQUEST_STATUS = { done: 'marked a request done', declined: 'declined a request', withdrawn: 'withdrew a request' } as const

const hours = (h: number) => (h === 1 ? '1 hour' : `${h} hours`)

/** Stage 1 M2: what each write operation does, as a person reads it (the audit log and the permissions list). */
export const OPERATION_TITLE: Readonly<Record<'shopify.order.tag_add' | 'slack.channel.post', string>> = {
  'shopify.order.tag_add': 'Add tags to orders',
  'slack.channel.post': 'Post messages to a channel',
}
const OPERATION_TOOL = { 'shopify.order.tag_add': 'Shopify', 'slack.channel.post': 'Slack' } as const
const operation = (op: keyof typeof OPERATION_TITLE) => `${OPERATION_TITLE[op]} in ${OPERATION_TOOL[op]}`
/** Every reason but `removed` (a person removed it, said as its own `what`). Typed so a new reason fails the typecheck. */
const REVOKED: Readonly<Record<Exclude<RevokeReason, 'removed'>, string>> = {
  member_removed: 'its holder left the team',
  role_lowered: 'its holder’s role changed',
  account_disconnected: 'the tool was disconnected',
  account_reconnected: 'the tool was connected again',
  restore: 'the brand’s data was restored from a backup',
  superseded: 'the rules or the tool’s connection changed, and a new one took its place',
  channel_unlisted: 'the channel was taken off the list',
}
const GUARDRAIL: Record<string, string> = {
  money: 'it moves money', customer: 'it reaches a customer', destructive: 'it can’t be undone', access: 'it changes who has access',
  bulk: 'it changes more than 5 records', count: 'today’s allowance is used up', unreviewed: 'it isn’t reviewed yet', browser: 'it uses the browser',
}
const LAPSED: Record<string, string> = {
  paused: 'the agent was paused', restore_hold: 'the brand’s data was being restored', expired: 'no one answered in 7 days',
  over_ceiling: 'this kind of action is turned off', policy_changed: 'the rules changed', account_changed: 'the tool’s connection changed',
  asker_removed: 'the person who asked left the team', approver_not_allowed: 'the approver can no longer approve it',
  channel_not_listed: 'the channel isn’t listed any more', permission_removed: 'the permission was removed', count: 'today’s allowance is used up',
  stale_approval: 'it wasn’t sent in time after the OK',
}
const NEEDS_CHECK: Record<string, string> = {
  timeout: 'no answer in time', unknown: 'the tool couldn’t say whether it went out', thrown: 'the call broke off',
  bad_result: 'the answer couldn’t be read', stale: 'it was sending for too long',
}
/** Why a send failed, from the hub's closed codes; any other code says the tool couldn't do it. */
const FAILED: Record<string, string> = {
  not_configured: 'writing to the tool isn’t set up', paused: 'the tool is paused', credentials_rejected: 'the tool refused the sign-in',
  scope_mismatch: 'the connection can’t do this', upstream_rejected: 'the tool refused it', upstream_unavailable: 'the tool couldn’t be reached',
  rate_limited: 'the tool asked to slow down', connect_stale: 'the tool’s connection changed', invalid_args: 'the tool refused the details',
}
const QUESTION_ASKED = { owner: 'Asked the person in the chat', creator: 'Asked the routine’s creator', admins: 'Asked the admins' } as const
const ANSWERED = { once: 'allowed an action once', always: 'allowed an action and said always allow', approve: 'approved an action', deny: 'declined an action' } as const

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
    case 'routine.created': return { what: 'set up a routine', detail: args.need === undefined ? '' : `Needs the ${NEED[args.need]} stage` }
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
    // P5 (p5-w1)
    case 'tools.connect_start': return { what: 'started connecting a tool', detail: connectorName(args.accountId) }
    case 'tools.connect':
      return args.outcome === 'ok'
        ? { what: 'connected a tool', detail: connectorName(args.accountId) }
        : { what: 'couldn’t connect a tool', detail: `${connectorName(args.accountId)}: ${CONNECT_FAILED[args.outcome] ?? args.outcome}` }
    // P5 (p5-w3)
    case 'tools.pause': return { what: args.paused ? 'paused a tool' : 'resumed a tool', detail: connectorName(args.accountId) }
    case 'tools.disconnect':
      return { what: 'disconnected a tool', detail: args.revoked ? connectorName(args.accountId) : `${connectorName(args.accountId)}: its access wasn’t removed on the tool’s side, so remove the app there too` }
    // P5 (p5-w4). Never the notice's text or title: the line holds neither.
    case 'notify.send': {
      if (args.target === 'unlisted') return { what: 'a notice didn’t go out', detail: 'Slack: a channel that isn’t listed' }
      const where = args.kind === 'slack' ? 'Slack' : args.target === 'admins' ? 'the admins’ bell' : `${who(args.target)}’s bell`
      const why = args.detail ? NOTIFY_DETAIL[args.detail] ?? args.detail : ''
      if (args.outcome === 'posted') return { what: args.kind === 'slack' ? 'posted a notice to Slack' : 'sent a notice to the bell', detail: args.detail === 'to_bell' || args.detail === 'channel_to_bell' ? `${where}: ${why}` : where }
      if (args.outcome === 'unknown') return { what: 'may have posted a notice', detail: `${where}: no answer, not retried` }
      return { what: 'a notice didn’t go out', detail: why ? `${where}: ${why}` : where }
    }
    case 'notify.channels': {
      const parts = [args.added.length ? `${plural(args.added.length, 'channel')} added` : '', args.removed.length ? `${plural(args.removed.length, 'channel')} removed` : '']
      if (args.alerts !== undefined) parts.push(args.alerts === null ? 'no alerts channel' : 'alerts channel set')
      return { what: 'changed the Slack channels for notices', detail: parts.filter(Boolean).join(', ') }
    }
    // P6a (PR0). Never the fact's or the request's text, and no revision number: the line keeps those for the record.
    case 'memory.approved': return { what: 'approved a team memory', detail: '' }
    case 'memory.rejected': return { what: 'rejected a team memory', detail: '' }
    case 'team_request.created': return { what: 'sent the Inhouse team a request', detail: REQUEST_KIND[args.kind] }
    case 'team_request.status': return { what: REQUEST_STATUS[args.status], detail: '' }
    // P6a brand skills. Never the skill's name, description or instructions.
    case 'brand_skill.created': return { what: 'made a skill in a chat', detail: '' }
    case 'brand_skill.changed': return { what: 'changed a skill in a chat', detail: '' }
    case 'brand_skill.deleted': return { what: 'deleted a skill', detail: '' }
    // Stage 1 M2. Never an action's arguments, a card's words, a question or its answer: the lines hold none.
    case 'permission.granted':
      return { what: 'let the agent act without asking', detail: args.holder === 'brand' ? `${operation(args.operation)}, for the whole team` : operation(args.operation) }
    case 'permission.revoked':
      return args.reason === 'removed'
        ? { what: 'removed a permission', detail: operation(args.operation) }
        : { what: 'a permission ended', detail: `${operation(args.operation)}: ${REVOKED[args.reason]}` }
    case 'action.requested':
      if (args.verdict === 'run') return { what: 'the agent acted under a permission', detail: operation(args.operation) }
      return { what: 'the agent asked for an approval', detail: args.guardrail ? `${operation(args.operation)}: needs an exact approval, ${GUARDRAIL[args.guardrail]}` : operation(args.operation) }
    case 'action.answered': return { what: ANSWERED[args.choice], detail: '' }
    case 'action.undone': return { what: 'undid an action before it went out', detail: '' }
    case 'action.withdrawn': return { what: args.by === 'agent' ? 'the agent withdrew an action' : 'withdrew an action', detail: '' }
    case 'action.lapsed': return args.reason === 'expired' ? { what: 'an action expired', detail: LAPSED.expired } : { what: 'an approval lapsed', detail: LAPSED[args.reason] }
    case 'action.sent': return { what: 'an action went out', detail: '' }
    case 'action.failed': return { what: 'an action didn’t go out', detail: FAILED[args.code] ?? 'the tool couldn’t do it' }
    case 'action.needs_check': return { what: 'an action needs a check', detail: NEEDS_CHECK[args.why] }
    case 'action.resolved': return { what: args.outcome === 'sent' ? 'confirmed an action went out' : 'confirmed an action didn’t go out', detail: '' }
    case 'question.asked': return { what: 'the agent asked a question', detail: QUESTION_ASKED[args.askedOf] }
    case 'question.answered': return { what: 'answered a question', detail: '' }
    case 'question.expired': return { what: 'a question expired', detail: 'No one answered in 7 days' }
    case 'data.exported': return { what: 'downloaded all brand data', detail: `${String(args.items).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${args.items === 1 ? 'item' : 'items'}` }
  }
}
