// The system prompt version a graded turn was sent (P5, #337): route 33's trace names it (`promptVersions`, one per turn
// of the trace, in order). The eval runners (targets/product.ts, morning-check/runner.ts, exfiltration/store-data/runner.ts)
// fail a turn that wasn't sent the current version. Each graded trace is one turn's, so the last entry is that turn's.

import { SYSTEM_PROMPT_VERSION } from '../server/prompt/system.ts'

/** The prompt every graded turn must have been sent: the current version (server/prompt/system.ts). */
export const GRADED_PROMPT_VERSION: number = SYSTEM_PROMPT_VERSION

/** The version a one-turn trace's `promptVersions` names: the number, or `missing` when it names none (an older build). */
export function promptVersionSent(versions: unknown): number | 'missing' {
  if (!Array.isArray(versions) || versions.length === 0) return 'missing'
  const last = versions[versions.length - 1]
  return typeof last === 'number' && Number.isInteger(last) ? last : 'missing'
}

/** The reason a graded case fails when its turn wasn't sent the current version (or it has no turn to check: `missing`). */
export const promptReason = (sent: number | 'missing'): string => `prompt_version:${sent}: the turn was not sent the system prompt v${GRADED_PROMPT_VERSION}`
