// The tool map in ../index.ts installs these fallbacks first, then replaces them with live handlers where available.
// The question tool currently returns `not_available_yet`.
import { z } from 'zod'
import { refusal, tool } from '../../server/tool.ts'
import type { InhouseToolName, ToolHandler } from '../../server/tool.ts'

/** Any arguments: the stub never reads them. */
const anything = z.object({}).catchall(z.unknown())

export function notAvailableYet(name: string): ToolHandler {
  return tool({
    input: anything,
    async call() {
      return refusal('not_available_yet', `${name} isn't available yet: it arrives in a later release. Tell the person you can't do this yet, and offer what you can do instead.`)
    },
  })
}

/** Initial fallback entries and the names a live handler may override. */
export const STUB_NAMES: readonly InhouseToolName[] = [
  'question_ask',
  'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  'notification_send',
]

export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = Object.fromEntries(STUB_NAMES.map(n => [n, notAvailableYet(n)]))
