// The one visibility rule (p3-design section 10) for `memory_search`, `memory_list`, `history_search`, `history_read`
// and route 43: a member sees the brand's active facts and their own active facts, and their own chats that aren't
// deleted. Waiting and forgotten facts, another member's person facts and another member's chats are never visible.
// Each is an SQL condition with one `?`, the member id; every read in this folder and in history/ uses it.

/** A visible fact, on the `memories` row aliased `alias`. One parameter: the member id. */
export const factVisible = (alias: string): string => `(${alias}.status = 'active' AND (${alias}.scope = 'brand' OR ${alias}.owner_id = ?))`

/** A visible chat, on the `chats` row aliased `alias`. One parameter: the member id. */
export const chatVisible = (alias: string): string => `(${alias}.owner_id = ? AND ${alias}.deleted_at_ms IS NULL)`

/**
 * An FTS5 MATCH expression from what the agent typed: each word a quoted term, each "quoted phrase" a phrase, any of
 * them matching (OR), ranked by bm25 at the call site. Words are runs of letters and digits, so no FTS5 operator,
 * column filter or quote ever reaches the expression from the input. Null when nothing searchable is left.
 */
export function matchExpression(input: string): string | null {
  const words = (s: string) => s.match(/[\p{L}\p{N}]+/gu) ?? []
  const parts: string[] = []
  const rest = input.replace(/"([^"]*)"/g, (_, phrase: string) => {
    const w = words(phrase)
    if (w.length > 0) parts.push(`"${w.join(' ')}"`)
    return ' '
  })
  for (const w of words(rest)) parts.push(`"${w}"`)
  const unique = [...new Set(parts)].slice(0, 32)
  return unique.length > 0 ? unique.join(' OR ') : null
}
