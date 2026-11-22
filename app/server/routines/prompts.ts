// A routine's turn text (p4-w2.md section 4, step 1): rendered once when its slot is decided and stored on the slot, so a
// re-submit sends it byte for byte. A system routine's text is ours, by its `prompt_ref`; a team routine's is the
// instruction a person gave, after a fixed line that says what kind of chat this is.
import type { OutputFormat } from '../../shared/protocol/index.ts'
import { RESULT_HANDLERS } from './results.ts'
import { MORNING_CHECK_PROMPT_V1 } from '../prompt/routines/morning-check.ts'
import { TEAM_ROUTINE_PREAMBLE } from '../prompt/routines/common.ts'

/**
 * The system routines' prompts, by `prompt_ref` (one line each, added with the routine's row: W3's morning check). An
 * unknown ref fails loud: that routine's pass throws, its cursor holds and the routines signal goes red on the lag.
 */
export const SYSTEM_ROUTINE_PROMPTS: Readonly<Record<string, string>> = {
  // W3's morning check; the text is the orchestrator's (prompt/routines/morning-check.ts).
  'morning-check': MORNING_CHECK_PROMPT_V1,
}

/**
 * The system routines' descriptions for the Routines page's `what` (section 9), by `prompt_ref`: one line each, added with
 * the routine's prompt (prompts.test.ts fails a prompt without one, so a missing one shows in CI, not on the page).
 */
export const SYSTEM_ROUTINE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  'morning-check': 'Checks the store each morning for orders, stock and money that need a person.',
}

export function systemDescription(ref: string | null): string {
  const key = ref ?? ''
  if (!Object.hasOwn(SYSTEM_ROUTINE_DESCRIPTIONS, key)) throw new Error(`systemDescription: no description for ${key}`)
  return SYSTEM_ROUTINE_DESCRIPTIONS[key]
}

export interface PromptSource {
  origin: 'system' | 'team'
  kind: string
  instruction: string
  prompt_ref: string | null
}

export function routinePrompt(r: PromptSource): string {
  if (r.origin === 'system') {
    const ref = r.prompt_ref ?? ''
    if (!Object.hasOwn(SYSTEM_ROUTINE_PROMPTS, ref)) throw new Error(`routinePrompt: no prompt for ${ref}`)
    return SYSTEM_ROUTINE_PROMPTS[ref]
  }
  return `${TEAM_ROUTINE_PREAMBLE}\n\n${r.instruction}`
}

/** The structured-output format a routine's kind asks for (its result handler's schema), if any. */
export const outputFormatOf = (kind: string): OutputFormat | undefined =>
  Object.hasOwn(RESULT_HANDLERS, kind) ? RESULT_HANDLERS[kind].outputFormat : undefined
