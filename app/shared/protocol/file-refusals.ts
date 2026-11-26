// The egress's answer when a session reads a text file holding more ids, emails or order numbers than the fetch leak
// check tracks in one read (server/egress/files.ts, M1-G): the file isn't served. The runner's restore leaves such a
// file out (it stays in the chat, not in the work folder) instead of failing the run; a direct read stays refused.
export const FILE_TOO_MANY_TOKENS = { status: 422, error: 'too_many_tokens' } as const
