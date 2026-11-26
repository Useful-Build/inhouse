// P3's chat registry entries (W1, p3-w1.md): `chats`, `chat_messages` (0100) and `tool_calls` (0101) join here in the
// PRs that add their migrations. PR0 added the BrandAgent's `do` entry (PR0 binds the class in wrangler.product.jsonc
// and the completeness test needs every bound class registered); W1's PR 4 completed it (p3-design sections 4.1, 4.10
// and 11). Its SQLite names a member in `runs.owner_id`, `turns.owner_id`, `chat_state.owner_id`,
// `run_tokens.member_id`, every `turn.queued` event's `by` (`events.json:$.by`), the removed set (`authority.id` where
// `kind = 'member'`) and who paused (`flags.value` where `key = 'paused_by'`). A socket's attachment holds the member id
// too, in the runtime's socket state rather than SQLite: it lives at most an hour (the lease) and goes with the socket.
// flags.egress_record_failed_at is an operational timestamp that holds no person data.
import type { TableEntry } from './types.ts'

export const chatTables: readonly TableEntry[] = [
  // 0100 (W1's first PR). A chat and its messages are the owner's; a user message names its author.
  { kind: 'd1', name: 'chats', retention: 'retention_period', personKeys: ['owner_id'], export: true },
  { kind: 'd1', name: 'chat_messages', retention: 'retention_period', personKeys: ['author_id'], export: true },
  // 0101 (W1's second PR): the redacted audit of a turn's tool calls, by the turn's member.
  { kind: 'd1', name: 'tool_calls', retention: 'retention_period', personKeys: ['member_id'], export: true },
  // Stage 1 M2-B: the object's `outbox_lag` (since when the outbox's gate has been behind it: a time and a generation, no
  // person key) is covered by this class-level entry, as the object's other tables are.
  { kind: 'do', name: 'BrandAgent', retention: 'retention_period', personKeys: ['runs.owner_id', 'turns.owner_id', 'chat_state.owner_id', 'run_tokens.member_id', 'events.json:$.by', 'authority.id', 'flags.value'], export: false },
]
