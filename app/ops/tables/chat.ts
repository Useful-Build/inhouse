// P3's chat registry entries (W1, p3-w1.md): `chats`, `chat_messages` (0100) and `tool_calls` (0101) join here in the
// PRs that add their migrations. PR0 adds the BrandAgent's `do` entry, because PR0 binds the class in
// wrangler.product.jsonc and the completeness test needs every bound class registered; W1's PR 4 owns it from then
// (p3-design sections 4.1 and 11). Its storage names a member in `runs.owner_id`, `turns.owner_id`,
// `chat_state.owner_id` and `run_tokens.member_id`.
import type { TableEntry } from './types.ts'

export const chatTables: readonly TableEntry[] = [
  { kind: 'do', name: 'BrandAgent', retention: 'retention_period', personKeys: ['runs.owner_id', 'turns.owner_id', 'chat_state.owner_id', 'run_tokens.member_id'], export: false },
]
