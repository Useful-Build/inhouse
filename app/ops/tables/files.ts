// P3's files registry entries (W3, p3-w3.md): `chat_files` (0120) and the `sessions/` and `files/` R2 prefixes join
// here in the PRs that add them. Empty until then (PR0).
import type { TableEntry } from './types.ts'

export const filesTables: readonly TableEntry[] = [
  // PR 1: the session store (p3-design 8.5). Keys name a chat and a session, never a member; the transcripts are the
  // engine's state behind a chat (its messages are in D1), so they go with the chat's retention and aren't exported.
  { kind: 'r2', name: 'sessions/', retention: 'retention_period', personKeys: [], export: false },
]
