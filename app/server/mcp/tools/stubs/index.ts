// The registered tools no phase has built yet (p3-design section 10): each answers a typed `not_available_yet` refusal,
// so the agent sees all 20 and tells the person plainly instead of guessing. A phase that builds one adds its area after
// `stubs` in ../index.ts, and its handler replaces the stub (approvals and questions P5, routines P4, notifications P5,
// Inhouse team requests P6).
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

/** The unbuilt tools. A later area may replace any of these; only these. */
export const STUB_NAMES: readonly InhouseToolName[] = [
  'approval_request', 'approval_get', 'approval_list', 'approval_withdraw',
  'question_ask',
  'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  'notification_send',
  'team_request_create', 'team_request_list',
]

export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = Object.fromEntries(STUB_NAMES.map(n => [n, notAvailableYet(n)]))
