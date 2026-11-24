// The data map's store list (P8 C1, acceptance 11): one Markdown table row per registry entry. docs/data-map.md is
// public, so every word here is plain and brand-free: what a store holds, its personal data, retention, deletion and
// any accepted keep come from a literal note per store (never a rule's internal `why`, which names reviews and
// decisions); kind and export come from the registry, the deletion's kind from the rule, and the Backup column from the
// backup's own table rules (ops/backup/tables.ts). The orchestrator commits the rendered block between the stores
// markers; data-map.test.ts fails when they differ. This module touches no bucket.
import { TABLE_RULES } from '../../backup/tables.ts'
import type { TableRule } from '../../backup/tables.ts'
import { deletionRules } from '../../delete/rules.ts'
import type { TableEntry } from '../../tables/types.ts'

interface Note {
  holds: string
  personal: string
  retention: string
  /** What a person's deletion does, in plain words; required where the rule keeps the store or runs a custom part. */
  deletion?: string
  /** The Backup column for a store that isn't a backed-up D1 table. */
  backup?: string
  keeps?: string
}

export const NOTES: Readonly<Record<string, Note>> = {
  members: { holds: 'Team members and service accounts', personal: 'Name, email, title, sign-in subject, photo key', retention: 'Kept while the deployment lives' },
  settings: { holds: 'Brand and personal settings', personal: 'Personal settings; an approver setting names a member id', retention: 'Kept while the deployment lives' },
  support_grants: { holds: 'Support access the brand granted', personal: 'Member ids of who granted and ended it', retention: 'Kept while the deployment lives', deletion: 'Kept: the access history keeps the member id, which no longer names anyone' },
  audit_log: { holds: 'The audit log', personal: 'Member ids only', retention: 'Never shortened', deletion: 'Kept: the audit log is never shortened or edited' },
  'photos/': { holds: 'Member photos', personal: 'Photo bytes', retention: 'Replaced on upload; deleted with the person', backup: 'Not backed up' },
  chats: { holds: 'Chats', personal: 'Owner id, titles', retention: 'Chats setting (default 12 months) from last activity; deleted chats 30 days after deletion', deletion: 'Deleted with all of the person\'s own chats, deleted ones included' },
  chat_messages: { holds: 'Chat messages, the agent\'s answers too', personal: 'Message text, author id', retention: 'With its chat', deletion: 'Deleted with the person\'s chats' },
  tool_calls: { holds: 'A record of each tool call, without its inputs', personal: 'Member id, input fingerprints', retention: 'Steps setting (default 12 months); with its chat', deletion: 'Deleted with the person\'s chats' },
  BrandAgent: { holds: 'The agent\'s live state: runs, turns, run events, run tokens', personal: 'Question text, run events, owner ids', retention: 'Finished runs by the steps setting; a chat\'s state with the chat', deletion: 'The person\'s runs, turns, events and tokens deleted, once none of their turns is still running', backup: 'Durable Object point-in-time recovery', keeps: 'A removed member\'s id in the removed list, so their sends stay refused' },
  'sessions/': { holds: 'Agent session transcripts', personal: 'Transcript text', retention: 'With its chat', deletion: 'Deleted with the person\'s chats', backup: 'Not backed up (kept through a database restore)' },
  chat_files: { holds: 'Chat attachments and outputs', personal: 'File names, uploader id', retention: 'With its chat; an output deleted from the Library goes 30 days after', deletion: 'Deleted with the person\'s chats' },
  'files/': { holds: 'Chat file bytes', personal: 'File bytes', retention: 'With its chat or its deleted file', deletion: 'Deleted with the person\'s chats', backup: 'Not backed up (kept through a database restore)' },
  usage_months: { holds: 'Monthly AI spend and cap', personal: 'None', retention: 'Kept while the deployment lives', deletion: 'Kept: no personal data' },
  usage_turns: { holds: 'Each turn\'s reserved and settled spend', personal: 'Member id', retention: 'Kept while the deployment lives', deletion: 'Kept: the brand\'s bill keeps the member id, which no longer names anyone' },
  usage_extends: { holds: 'Each model call\'s hold and cost', personal: 'None', retention: 'Kept while the deployment lives', deletion: 'Kept: no personal data' },
  audit_copy_state: { holds: 'Where the audit log\'s daily copy has reached', personal: 'None', retention: 'Kept while the deployment lives', deletion: 'Kept: no personal data' },
  'audit-copy/': { holds: 'The audit log\'s daily copy', personal: 'Member ids only', retention: 'Never shortened', deletion: 'Kept: the audit log\'s copy is never shortened', backup: 'Not backed up (it is itself a copy)' },
  memories: { holds: 'Remembered facts, including waiting, approved and rejected brand facts', personal: 'Fact text, owner and creator ids; the audit log records who approved or rejected a fact', retention: 'Forgotten facts, including rejected ones, 30 days after their last change; waiting and active facts kept', keeps: 'Brand facts a person saved' },
  memories_fts: { holds: 'The search index over facts', personal: 'A copy of fact text', retention: 'Follows its source' },
  chat_messages_fts: { holds: 'The search index over messages', personal: 'A copy of message text', retention: 'Follows its source' },
  Runner: { holds: 'The agent runners\' working state', personal: 'None', retention: 'Holds nothing kept', deletion: 'Kept: no personal data', backup: 'Nothing to restore' },
  activity_lines: { holds: 'The Activity feed', personal: 'Member ids only, names shown when read', retention: 'Steps setting (default 12 months)', deletion: 'Kept: lines keep the member id and show "Former member"' },
  notices: { holds: 'The bell\'s notices', personal: 'Member ids; team and admin notices may carry text', retention: 'Steps setting (default 12 months)', deletion: 'Notices addressed only to the person deleted, with their reads', keeps: 'Team and admin notice text' },
  notice_reads: { holds: 'Which member read which notice', personal: 'Member id', retention: 'With its notice' },
  routines: { holds: 'Routines', personal: 'Instruction text, creator id', retention: 'Kept while the routine is', deletion: 'Kept: a routine keeps running after its creator leaves; the creator id no longer names anyone', keeps: 'Routine instructions' },
  routine_slots: { holds: 'Each routine run', personal: 'Prompt and result text, creator and requester ids', retention: 'Steps setting (default 12 months)', deletion: 'Kept: routine history keeps the member ids, which no longer name anyone', keeps: 'Routine prompts and results' },
  routine_alerts: { holds: 'Two internal counters', personal: 'None', retention: 'Kept while the deployment lives', deletion: 'Kept: no personal data' },
  library_uploads: { holds: 'Library uploads', personal: 'File names, uploader id', retention: 'Unfinished uploads after 1 day; deleted files 30 days after deletion; otherwise until deleted', deletion: 'Kept: the brand\'s own files keep the uploader id, which no longer names anyone' },
  library_marks: { holds: 'Library files moved to the trash', personal: 'Member id of who deleted', retention: 'With its file', deletion: 'Kept: the brand\'s trash keeps the member id; marks on the person\'s chat outputs go with their chats' },
  'library/': { holds: 'Library file bytes', personal: 'File bytes', retention: 'With its upload', deletion: 'Kept: the brand\'s own files', backup: 'Not backed up (kept through a database restore)' },
  today_items: { holds: 'Today\'s items', personal: 'Store data, no member id', retention: 'Steps setting (default 12 months)', deletion: 'Kept: no member id', keeps: 'Today item text' },
  today_aside: { holds: 'Today items set aside', personal: 'Member id', retention: 'Steps setting (default 12 months)', deletion: 'Kept: the team\'s Today keeps the member id, which no longer names anyone' },
  'backups/': { holds: 'Database backups', personal: 'Copies of every backed-up table', retention: '30 days (bucket lifecycle rule)', deletion: 'Kept: backups expire after 30 days, so a deleted person leaves them within that window', backup: 'Is the backup' },
  'restore/': { holds: 'Restore records and snapshots', personal: 'A copy of the audit log at a restore', retention: '30 days (bucket lifecycle rule)', deletion: 'Kept: expires after 30 days, like the backups', backup: 'Restore records' },
  'deletion-log/': { holds: 'What each deletion and retention run removed', personal: 'Member ids and counts only', retention: 'Never shortened', deletion: 'Kept: the deletion log is never shortened', backup: 'Not backed up (replayed after a restore)' },
  egress_fetches: { holds: 'Outbound web requests by host', personal: 'None', retention: '30 days', deletion: 'Kept: no member id; removed after 30 days' },
  connector_accounts: { holds: 'Brand connector status and lifecycle', personal: 'Member ids of who connected or disconnected', retention: 'Kept while the deployment lives', deletion: 'Kept: member ids no longer identify the deleted person' },
  notify_channels: { holds: 'Current and removed Slack notice channels', personal: 'Member ids of who added or removed each channel', retention: 'Kept while the deployment lives', deletion: 'Kept: member ids no longer identify the deleted person' },
  notify_channel_list: { holds: 'Slack channel list revision', personal: 'None', retention: 'Kept while the deployment lives', deletion: 'Kept: no personal data' },
  notify_sends: { holds: 'Notice delivery outcomes, caps and deduplication keys', personal: 'Sender and bell recipient ids', retention: 'Steps setting (default 12 months)', deletion: 'Kept for caps and deduplication. Member ids no longer identify the deleted person' },
  SignIn: { holds: 'The connector hub’s sealed tokens and pending OAuth state', personal: 'Member ids of who connected or started connecting', retention: 'Credentials kept while connected. Pending items expire', deletion: 'The brand connection stays. Member ids no longer identify the deleted person', backup: 'Not restored: reconnect' },
  team_requests: { holds: 'Requests to the support team', personal: 'Requester id, request text and subject', retention: 'Kept while the deployment lives or until the requester is deleted' },
  brand_skills: { holds: 'Skills written by the brand', personal: 'Maker and editor ids, skill description and instructions', retention: 'Kept until the skill is deleted', deletion: 'The skill stays; the deleted member’s maker and editor links are cleared', keeps: 'Skill description and instructions' },
  privacy_requests: { holds: 'Shopify privacy requests and their status', personal: 'Shopify customer and order IDs while open', retention: 'Request record kept while the deployment lives; customer and order IDs cleared on close', deletion: 'Kept: no team member ID' },
}

/** The Backup column for a backed-up D1 table, by its mode. */
export const BACKUP_TEXT: Readonly<Record<TableRule['mode'], string>> = {
  snapshot: 'Nightly, exact',
  append_only: 'Nightly, exact (rows only added)',
  insert_only: 'Nightly, exact unless rows arrive during the copy',
  paged: 'Nightly, copied in pages (may lag the snapshot by minutes)',
}

const KIND: Record<TableEntry['kind'], string> = { d1: 'D1 table', do: 'Durable Object', r2: 'R2 prefix' }

function deletionText(e: TableEntry, note: Note): string {
  const rule = deletionRules[e.name]
  if (!rule) throw new Error(`data map: no deletion rule for ${e.name}`)
  switch (rule.action) {
    case 'pseudonymise': return 'Name and email removed; the member id stays'
    case 'delete_rows': return note.deletion ?? 'Rows that belong to the person deleted'
    case 'delete_objects': return note.deletion ?? 'Objects that belong to the person deleted'
    case 'derived': return 'Follows its source'
    case 'custom':
    case 'keep':
      if (!note.deletion) throw new Error(`data map: no plain deletion text for ${e.name}`)
      return note.deletion
  }
}

function backupText(e: TableEntry, note: Note): string {
  if (e.kind === 'd1') {
    if (e.derived) return 'Rebuilt from its source after a restore'
    const rule = TABLE_RULES.find(r => r.name === e.name)
    if (!rule) throw new Error(`data map: no backup rule for ${e.name}`)
    return BACKUP_TEXT[rule.mode]
  }
  if (!note.backup) throw new Error(`data map: no Backup text for ${e.name}`)
  return note.backup
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The rows (with their header), one per entry, in registry order. Throws by name on an entry with no note or rule. */
export function dataMapRows(registry: readonly TableEntry[]): string {
  const lines = [
    '| Store | Kind | Holds | Personal data | Retention | Export | Deletion | Backup | Accepted keep |',
    '|---|---|---|---|---|---|---|---|---|',
  ]
  for (const e of registry) {
    const n = NOTES[e.name]
    if (!n) throw new Error(`data map: no note for ${e.name}`)
    lines.push(`| \`${e.name}\` | ${KIND[e.kind]} | ${cell(n.holds)} | ${cell(n.personal)} | ${cell(n.retention)} | ${e.export ? 'Yes' : 'No'} | ${cell(deletionText(e, n))} | ${cell(backupText(e, n))} | ${cell(n.keeps ?? '')} |`)
  }
  return lines.join('\n')
}
