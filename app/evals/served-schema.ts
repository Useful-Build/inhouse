// Which tools the product serves with an open input schema (no fields): a stub's `anything` (server/mcp/tools/stubs),
// before P4-P6 build the real tool. A case expecting one doesn't grade its args (the model has no field names to follow),
// and says so on its row and in the README. Derived from what the server serves: the real composition (TOOL_HANDLERS)
// and the same `z.toJSONSchema(input, { io: 'input' })` the server lists tools with (server/mcp/server/index.ts:53), so
// when a phase replaces a stub, its cases grade args again with no harness edit.
//
// Node can't load the server's module graph on its own: server/http.ts imports `public/_headers?raw`, a Vite-only form.
// A load hook here serves any `?raw` import as its file's text, for this process only; no server file changes.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

let hooked = false
function hookRawImports(): void {
  if (hooked) return
  hooked = true
  registerHooks({
    load(url, context, next) {
      if (!url.endsWith('?raw')) return next(url, context)
      const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
      return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
    },
  })
}

/**
 * True for exactly the stub's open object (`z.object({}).catchall(z.unknown())`: an object, no properties, any extra field
 * allowed). Not a union (anyOf/oneOf/allOf, no top-level properties), not a strict empty object (additionalProperties
 * false), not one with fields (#282 re-review L3).
 */
export function isOpenSchema(input: z.ZodType): boolean {
  const s = z.toJSONSchema(input, { io: 'input' }) as { type?: unknown; properties?: Record<string, unknown>; additionalProperties?: unknown; anyOf?: unknown; oneOf?: unknown; allOf?: unknown }
  if (s.type !== 'object' || s.anyOf !== undefined || s.oneOf !== undefined || s.allOf !== undefined) return false
  if (s.properties !== undefined && Object.keys(s.properties).length > 0) return false
  return s.additionalProperties !== undefined && s.additionalProperties !== false
}

/** The tools the server serves with an open input schema, by name (`notification_send`). */
export async function openSchemaTools(): Promise<ReadonlySet<string>> {
  hookRawImports()
  // Loaded by path at run time: a literal specifier would pull the server's module graph into evals/'s type project,
  // which has no Worker Env.
  const path = '../server/mcp/tools/index.ts'
  const { TOOL_HANDLERS } = (await import(/* @vite-ignore */ path)) as { TOOL_HANDLERS: ReadonlyMap<string, { input: z.ZodType }> }
  return new Set([...TOOL_HANDLERS].filter(([, h]) => isOpenSchema(h.input)).map(([name]) => name))
}
