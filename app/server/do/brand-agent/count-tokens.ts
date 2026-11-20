// The CLI's own `count_tokens` calls pass the spend gate unpriced, at most 50 per turn (p3-design 8.2). The egress asks
// `BrandAgentRpc.noteCountTokens(turnId)` before forwarding one: the count lives on the turn's row
// (`turns.count_tokens_calls`, added with the `turns` table in W1's next PR) and moves in one conditional UPDATE, so
// two calls at once can't both take the 50th slot.

/** The most `count_tokens` calls one turn may make. */
export const COUNT_TOKENS_MAX = 50

/** Counts one call; true while the turn had made fewer than 50 before it, false from then on (and for an unknown turn). */
export function noteCountTokens(sql: SqlStorage, turnId: string): boolean {
  return sql.exec(
    'UPDATE turns SET count_tokens_calls = count_tokens_calls + 1 WHERE turn_id = ? AND count_tokens_calls < ?',
    turnId, COUNT_TOKENS_MAX,
  ).rowsWritten > 0
}
