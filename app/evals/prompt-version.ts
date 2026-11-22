// The system prompt a graded turn was sent (P5, #337): route 33's trace names its version (`promptVersions`) and the apps
// its built line named as connected (`promptApps`), one entry per turn of the trace, in order. The eval runners
// (targets/product.ts, morning-check/runner.ts, exfiltration/store-data/runner.ts) fail a turn that wasn't sent the
// current version, or whose prompt didn't name Shopify. Each graded trace is one turn's, so the last entry is that turn's.
import { SYSTEM_PROMPT_VERSION } from '../server/prompt/system.ts'

/** The prompt every graded turn must have been sent: the current version (server/prompt/system.ts). */
export const GRADED_PROMPT_VERSION: number = SYSTEM_PROMPT_VERSION
/** The app every graded turn's prompt must name as connected (the store the graded cases read). */
export const GRADED_PROMPT_APP = 'Shopify'

/** What a turn's prompt was, as its trace says: `missing` where the trace names nothing (an older build, no turn). */
export type PromptSent = { version: number | 'missing'; apps: readonly string[] | 'missing' }
export const NO_PROMPT: PromptSent = { version: 'missing', apps: 'missing' }

const last = (xs: unknown): unknown => (Array.isArray(xs) && xs.length > 0 ? xs[xs.length - 1] : undefined)

/** The version a one-turn trace's `promptVersions` names: the number, or `missing` when it names none. */
export function promptVersionSent(versions: unknown): number | 'missing' {
  const v = last(versions)
  return typeof v === 'number' && Number.isInteger(v) ? v : 'missing'
}

/** A one-turn trace's prompt: its version and the apps its prompt named. */
export function promptSentOf(trace: unknown): PromptSent {
  const t = (trace ?? {}) as { promptVersions?: unknown; promptApps?: unknown }
  const apps = last(t.promptApps)
  return { version: promptVersionSent(t.promptVersions), apps: Array.isArray(apps) && apps.every(a => typeof a === 'string') ? apps as string[] : 'missing' }
}

/** The graded check's failure code (`prompt_version:<v>` first, then `prompt_apps:<list|none|missing>`), or null when it passes. */
export function promptFailure(sent: PromptSent): string | null {
  if (sent.version !== GRADED_PROMPT_VERSION) return `prompt_version:${sent.version}`
  if (sent.apps === 'missing') return 'prompt_apps:missing'
  if (!sent.apps.includes(GRADED_PROMPT_APP)) return `prompt_apps:${sent.apps.length === 0 ? 'none' : sent.apps.join(',')}`
  return null
}

/** A failure code in words, for a case's reasons and a row's error. */
export const promptReason = (failure: string): string =>
  failure.startsWith('prompt_version:')
    ? `${failure}: the turn was not sent the system prompt v${GRADED_PROMPT_VERSION}`
    : `${failure}: the turn's prompt did not name ${GRADED_PROMPT_APP} as connected`
