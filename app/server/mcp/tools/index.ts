// The `inhouse` server's handlers, composed from one module per area (p3-design section 10). Each area folder exports
// `handlers: Partial<Record<InhouseToolName, ToolHandler>>` from its `index.ts`; a phase that builds tools adds one
// import and one entry in `AREAS` here, after `stubs`, and edits nothing else. The rules, checked when this module
// loads (a broken composition fails the Worker's start and every test, never a call):
//  - a later area may replace only a name `stubs` declares; any other name in two areas fails;
//  - every registry tool has exactly one handler, and no handler names a tool outside the registry.
import { INHOUSE_TOOLS } from '../registry.ts'
import { INHOUSE_TOOL_NAMES } from '../server/tool.ts'
import type { InhouseToolName, ToolHandler } from '../server/tool.ts'
import { handlers as approvals } from './approvals/index.ts'
import { handlers as history } from './history/index.ts'
import { handlers as memory } from './memory/index.ts'
import { handlers as notifications } from './notifications/index.ts'
import { handlers as questions } from './questions/index.ts'
import { handlers as routines } from './routines/index.ts'
import { STUB_NAMES, handlers as stubs } from './stubs/index.ts'
import { handlers as skills } from './skills/index.ts'
import { handlers as team } from './team/index.ts'
import { memberFind } from './team/member-find.ts'

export type Area = readonly [name: string, handlers: Partial<Record<InhouseToolName, ToolHandler>>]

/** The areas, stubs first. One line per area. */
const AREAS: readonly Area[] = [
  ['stubs', stubs],
  ['memory', memory],
  ['history', history],
  ['notifications', notifications],
  ['routines', routines],
  ['team', team],
  ['skills', skills],
  // Stage 1 M2-Q (N16).
  ['questions', questions],
  ['approvals', approvals],
  // Stage 1 M3-T (N28).
  ['people', { member_find: memberFind }],
]

/** The map the server serves, or a thrown error naming what breaks the rules. Exported for its tests. */
export function composeHandlers(areas: readonly Area[], registry: readonly string[], stubNames: readonly string[]): ReadonlyMap<string, ToolHandler> {
  const out = new Map<string, ToolHandler>()
  const from = new Map<string, string>()
  for (const [area, handlers] of areas) {
    for (const [name, handler] of Object.entries(handlers)) {
      if (!handler) continue
      const earlier = from.get(name)
      if (earlier !== undefined && !(earlier === 'stubs' && stubNames.includes(name))) throw new Error(`inhouse MCP: ${name} has two handlers (${earlier}, ${area})`)
      if (!registry.includes(name)) throw new Error(`inhouse MCP: ${area} handles ${name}, which isn't in the registry`)
      out.set(name, handler)
      from.set(name, area)
    }
  }
  const missing = registry.filter(n => !out.has(n))
  if (missing.length > 0) throw new Error(`inhouse MCP: no handler for ${missing.join(', ')}`)
  return out
}

const registryNames = INHOUSE_TOOLS.map(t => t.name)
if (registryNames.join() !== INHOUSE_TOOL_NAMES.join()) throw new Error('inhouse MCP: INHOUSE_TOOL_NAMES no longer matches the registry')

/** Every registry tool's handler. */
export const TOOL_HANDLERS = composeHandlers(AREAS, registryNames, STUB_NAMES)
