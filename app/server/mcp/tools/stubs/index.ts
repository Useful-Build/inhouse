// The registered tools no phase has built yet (p3-design section 10): each answers a typed `not_available_yet` refusal,
// so the agent sees all 20 and tells the person plainly instead of guessing. Each owner replaces its stub when its
// phase builds the tool (approvals and questions P5, routines P4, notifications P5, Inhouse team requests P6).
import { z } from 'zod'
import { refusal, tool } from '../../server/tool.ts'
import type { ToolImpl } from '../../server/tool.ts'

/** Any arguments: the stub never reads them. */
const anything = z.object({}).catchall(z.unknown())

export function notAvailableYet(name: string): ToolImpl {
  return tool({
    input: anything,
    async call() {
      return refusal('not_available_yet', `${name} isn't available yet: it arrives in a later release. Tell the person you can't do this yet, and offer what you can do instead.`)
    },
  })
}
