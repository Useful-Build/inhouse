// P3's chat registry entries (W1, p3-w1.md): `chats`, `chat_messages` (0100) and `tool_calls` (0101) join here in the
// PRs that add their migrations. PR0 adds the BrandAgent's `do` entry, because PR0 binds the class in
// wrangler.product.jsonc and the completeness test needs every bound class registered; W1's PR 4 owns it from then
// (p3-design sections 4.1 and 11). Its storage names a member in `runs.owner_id`, `turns.owner_id`,
// `chat_state.owner_id` and `run_tokens.member_id`.
import type { TableEntry } from './types.ts'

export const chatTables: readonly TableEntry[] = [
  // 0100 (W1's first PR). A chat and its messages are the owner's; a user message names its author.
  { kind: 'd1', name: 'chats', retention: 'retention_period', personKeys: ['owner_id'], export: true },
  { kind: 'd1', name: 'chat_messages', retention: 'retention_period', personKeys: ['author_id'], export: true },
  // 0101 (W1's second PR): the redacted audit of a turn's tool calls, by the turn's member.
  { kind: 'd1', name: 'tool_calls', retention: 'retention_period', personKeys: ['member_id'], export: true },
  { kind: 'do', name: 'BrandAgent', retention: 'retention_period', personKeys: ['runs.owner_id', 'turns.owner_id', 'chat_state.owner_id', 'run_tokens.member_id'], export: false },
]
