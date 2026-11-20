// Running live cases through the tools' own `run`, and comparing two runs (the differential). Shared by the recorder's
// step engine and the live script.
import type { HubResult } from '../../../hub/index/contract'
import { err, ok } from '../../../hub/index/errors'
import type { ShopifyReadClient, ToolDef } from '../../../hub/registry/registry'
import { shopifyConnector } from '../../../hub/connectors/shopify/route'
import type { LiveCase } from './cases'

export const TOOLS: ReadonlyMap<string, ToolDef<any>> = new Map(shopifyConnector.tools.map(t => [t.name, t]))

const SCOPE = { kind: 'server', job: 'shopify-live', requestId: 'shopify-live' } as const

export function toolFor(c: LiveCase): ToolDef<any> {
  const t = TOOLS.get(c.tool)
  if (!t) throw new Error(`case "${c.name}": unknown tool ${c.tool}`)
  return t
}

/** The input for page `page` (0-based), given the previous page's result. */
export function pageInput(c: LiveCase, previous: unknown): Record<string, unknown> {
  if (previous === undefined) return c.input
  const cursor = (previous as { nextCursor?: unknown }).nextCursor
  if (typeof cursor !== 'string') throw new Error(`case "${c.name}": no cursor for the next page`)
  return { ...c.input, after: cursor }
}

export const hasNext = (result: unknown) => typeof (result as { nextCursor?: unknown } | null)?.nextCursor === 'string'

/** Runs a case through the tool, following nextCursor up to `pages`. */
export async function runCase(c: LiveCase, client: ShopifyReadClient): Promise<HubResult<unknown[]>> {
  const tool = toolFor(c)
  const out: unknown[] = []
  for (let page = 0; page < (c.pages ?? 1); page++) {
    if (page > 0 && !hasNext(out[page - 1])) break
    const input = tool.input.safeParse(pageInput(c, out[page - 1]))
    if (!input.success) return err('invalid_args', c.tool)
    const r = await tool.run({ shopify: client, scope: SCOPE, nowMs: 0 }, input.data)
    if (!r.ok) return r
    out.push(r.value)
  }
  return ok(out)
}

/** The document and variables a tool sends for `input`, captured without sending anything. */
export async function captureRequest(tool: ToolDef<any>, input: unknown): Promise<{ query: string; variables: Record<string, unknown> }> {
  const parsed = tool.input.safeParse(input)
  if (!parsed.success) throw new Error(`invalid input for ${tool.name}`)
  let captured: { query: string; variables: Record<string, unknown> } | null = null
  await tool.run(
    {
      shopify: {
        graphql: async (query, variables) => {
          captured = { query, variables: variables ?? {} }
          return err('internal')
        },
      },
      scope: SCOPE,
      nowMs: 0,
    },
    parsed.data,
  )
  if (!captured) throw new Error(`${tool.name} sent nothing`)
  return captured
}

const GID = /^gid:\/\/shopify\/([A-Za-z]+)\/\d+$/

/**
 * Makes two runs comparable: cursors become whether there is one; gids and location names go through the maps when
 * given (record mode, where the renumbering is known), else down to their type (check mode).
 */
export function normalise(v: unknown, maps?: { ids: ReadonlyMap<string, string>; locations: ReadonlyMap<string, string> }, key = ''): unknown {
  if (Array.isArray(v)) return v.map(x => normalise(x, maps))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = k === 'nextCursor' ? x !== null : normalise(x, maps, k)
    return out
  }
  if (typeof v === 'string') {
    const m = GID.exec(v)
    if (m) return maps ? (maps.ids.get(v) ?? v) : `gid://shopify/${m[1]}/*`
    if (key === 'location') return maps ? (maps.locations.get(v) ?? v) : 'Location *'
  }
  return v
}

/** The first path where two values differ, or null. Says where, never what (values can be store data). */
export function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
    for (const k of keys) {
      const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
      if (d) return d
    }
    return null
  }
  return Object.is(a, b) ? null : `${path}: values differ`
}
