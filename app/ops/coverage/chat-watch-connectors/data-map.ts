// The data map's store list (P8 C1, acceptance 11): one Markdown table row per registry entry, from a literal note per
// store (what it holds, its personal data, its retention, and any accepted keep) and the registry and rules themselves
// (kind, export, the deletion rule), so the map can't drift from what the jobs do. No brand detail. The orchestrator
// commits the rendered block between the stores markers in docs/data-map.md; data-map.test.ts fails when they differ.
// This module touches no bucket.
import { deletionRules } from '../../delete/rules.ts'
import type { DeletionRule } from '../../delete/rules.ts'
import type { TableEntry } from '../../tables/types.ts'

interface Note { holds: string; personal: string; retention: string; keeps?: string }

export const NOTES: Readonly<Record<string, Note>> = {
  members: { holds: 'Team members and service rows', personal: 'Name, email, title, sign-in subject, photo key', retention: 'Kept while the deployment lives' },
  settings: { holds: 'Brand and personal settings', personal: 'Personal settings; an approver setting names a member id', retention: 'Kept while the deployment lives' },
  support_grants: { holds: 'Inhouse team support grants', personal: 'Member ids of who granted and ended them', retention: 'Kept while the deployment lives' },
  audit_log: { holds: 'The audit log', personal: 'Member ids only', retention: 'Never shortened' },
  'photos/': { holds: 'Member photos', personal: 'Photo bytes', retention: 'Replaced on upload; with the person' },
  chats: { holds: 'Chats', personal: 'Owner id, titles', retention: 'Chats setting (default 12 months) from last activity; trash 30 days' },
  chat_messages: { holds: 'Chat messages, the agent\'s answers too', personal: 'Message text, author id', retention: 'With its chat' },
  tool_calls: { holds: 'A redacted record of each tool call', personal: 'Member id, input hashes', retention: 'Steps setting (default 12 months); with its chat' },
  BrandAgent: { holds: 'The agent\'s live state: runs, turns, run events, run tokens', personal: 'Turn text, run events, owner ids', retention: 'Ended runs by the steps setting; a chat\'s rows with the chat', keeps: 'A removed member\'s id in the removed set (refuses their sends)' },
  'sessions/': { holds: 'Agent session transcripts', personal: 'Transcript text', retention: 'With its chat' },
  chat_files: { holds: 'Chat attachments and outputs', personal: 'File names, uploader id', retention: 'With its chat; a Library-deleted output 30 days after its mark' },
  'files/': { holds: 'Chat file bytes', personal: 'File bytes', retention: 'With its chat or its trashed row' },
  usage_months: { holds: 'Monthly AI spend and cap', personal: 'None', retention: 'Kept while the deployment lives' },
  usage_turns: { holds: 'Each turn\'s reserved and settled spend', personal: 'Member id', retention: 'Kept while the deployment lives' },
  usage_extends: { holds: 'Each model call\'s hold and cost', personal: 'None', retention: 'Kept while the deployment lives' },
  audit_copy_state: { holds: 'The audit copy\'s cursor', personal: 'None', retention: 'Kept while the deployment lives' },
  'audit-copy/': { holds: 'The audit log\'s daily copy', personal: 'Member ids only', retention: 'Never shortened' },
  memories: { holds: 'Remembered facts, brand and personal', personal: 'Fact text, owner and creator ids', retention: 'Forgotten facts 30 days after their last update; others kept', keeps: 'Brand facts a person saved' },
  memories_fts: { holds: 'The search index over facts', personal: 'A copy of fact text', retention: 'Follows its source' },
  chat_messages_fts: { holds: 'The search index over messages', personal: 'A copy of message text', retention: 'Follows its source' },
  Runner: { holds: 'The runner pool\'s container state', personal: 'None', retention: 'Holds nothing kept' },
  activity_lines: { holds: 'The Activity feed', personal: 'Member ids only, names shown at read', retention: 'Steps setting (default 12 months)' },
  notices: { holds: 'The bell\'s notices', personal: 'Member ids; team and admin notices may carry text', retention: 'Steps setting (default 12 months)', keeps: 'Team and admin notice text' },
  notice_reads: { holds: 'Which member read which notice', personal: 'Member id', retention: 'With its notice' },
  routines: { holds: 'Routines', personal: 'Instruction text, creator id', retention: 'Kept while the routine is', keeps: 'Routine instructions (a routine runs on after its creator is removed)' },
  routine_slots: { holds: 'Each routine run', personal: 'Prompt and result text, creator and requester ids', retention: 'Steps setting (default 12 months)', keeps: 'Routine prompts and results' },
  routine_alerts: { holds: 'Two invariant counters', personal: 'None', retention: 'Kept while the deployment lives' },
  library_uploads: { holds: 'Library uploads', personal: 'File names, uploader id', retention: 'Pending after 1 day; trash 30 days after its mark; otherwise until deleted' },
  library_marks: { holds: 'Library trash marks', personal: 'Member id of who deleted', retention: 'With its file' },
  'library/': { holds: 'Library file bytes', personal: 'File bytes', retention: 'With its upload row' },
  today_items: { holds: 'Today\'s items', personal: 'Store data, no person key', retention: 'Steps setting (default 12 months)', keeps: 'Today item text' },
  today_aside: { holds: 'Today items set aside', personal: 'Member id', retention: 'Steps setting (default 12 months)' },
  'backups/': { holds: 'D1 backups', personal: 'Copies of every backed-up table', retention: '30 days (bucket lifecycle rule)' },
  'restore/': { holds: 'Restore records and snapshots', personal: 'A copy of the audit log at a restore', retention: '30 days (bucket lifecycle rule)' },
  'deletion-log/': { holds: 'What each deletion and retention run removed', personal: 'Member ids and counts only', retention: 'Never shortened' },
  egress_fetches: { holds: 'Outbound web requests by host', personal: 'None', retention: '30 days' },
  SignIn: { holds: 'The connector hub\'s sealed tokens', personal: 'None (client credentials)', retention: 'Kept while the connection is' },
}

const KIND: Record<TableEntry['kind'], string> = { d1: 'D1 table', do: 'Durable Object', r2: 'R2 prefix' }

function deletionText(rule: DeletionRule | undefined, store: string): string {
  if (!rule) throw new Error(`data map: no deletion rule for ${store}`)
  switch (rule.action) {
    case 'pseudonymise': return 'Pseudonymised in place (the id stays)'
    case 'delete_rows': return `Rows whose \`${rule.column}\` is the person deleted`
    case 'delete_objects': return 'Objects under the person\'s prefix deleted'
    case 'custom': return `Deleted: ${rule.why}`
    case 'derived': return 'Follows its source'
    case 'keep': return `Kept: ${rule.why}`
  }
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')

/** The rows (with their header), one per entry, in registry order. Throws by name on an entry with no note or rule. */
export function dataMapRows(registry: readonly TableEntry[]): string {
  const lines = [
    '| Store | Kind | Holds | Personal data | Retention | Export | Deletion | Accepted keep |',
    '|---|---|---|---|---|---|---|---|',
  ]
  for (const e of registry) {
    const n = NOTES[e.name]
    if (!n) throw new Error(`data map: no note for ${e.name}`)
    lines.push(`| \`${e.name}\` | ${KIND[e.kind]} | ${cell(n.holds)} | ${cell(n.personal)} | ${cell(n.retention)} | ${e.export ? 'Yes' : 'No'} | ${cell(deletionText(deletionRules[e.name], e.name))} | ${cell(n.keeps ?? '')} |`)
  }
  return lines.join('\n')
}
