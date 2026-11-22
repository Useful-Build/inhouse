// The system prompt version a graded turn was sent (P5, #337): route 33's trace names it (`promptVersions`, one per turn
// of the trace, in order). The eval runners (targets/product.ts, morning-check/runner.ts) fail a turn that wasn't sent v3.

/** The prompt every graded turn must have been sent. */
export const GRADED_PROMPT_VERSION = 3

/** The version a one-turn trace's `promptVersions` names: the number, or `missing` when it names none (an older build). */
export function promptVersionSent(versions: unknown): number | 'missing' {
  if (!Array.isArray(versions) || versions.length === 0) return 'missing'
  const last = versions[versions.length - 1]
  return typeof last === 'number' && Number.isInteger(last) ? last : 'missing'
}
