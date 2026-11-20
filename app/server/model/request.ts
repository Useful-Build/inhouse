// The model gate's look at one Messages request (p3-design 8.2), before anything is sent: what it may not carry (400
// before any call), the clamps, the price-affecting values, the byte bound and the projection `count_tokens` is asked
// about. Pure: no I/O.
//
// Messages API fields (docs, read 2026-11-20: https://platform.claude.com/docs/en/api/messages/create and
// /api/messages/count_tokens). `count_tokens` takes nine fields: messages, model, cache_control, output_config, speed,
// system, thinking, tool_choice, tools. Image sources are `base64`, `url` or `file`; document sources `base64` (PDF),
// `text`, `content`, `url` or `file`. Web search tools are `web_search_<date>` with `name: "web_search"`.
import type { Price } from './catalog.ts'
import { multipliersOf } from './pricing.ts'
import type { InputRate, PriceModifiers } from './pricing.ts'

/** The highest `max_tokens` a call may ask for (clamped down to it). */
export const MAX_OUTPUT_TOKENS = 32_000
/** The most web searches one call may make (`max_uses` clamped down to it, and set to it when absent). */
export const MAX_SEARCH_USES = 5
/** Input tokens allowed per search use (search results enter the context inside the call). */
export const SEARCH_INPUT_ALLOWANCE = 10_000
/** A call whose input bound (margin included, search allowance not) is over this is refused (item 22 E2). */
export const INPUT_BOUND = 650_000
/** The byte bound's fixed allowances (8.2 step 1, CHOICE). */
export const IMAGE_ALLOWANCE = 5_000
export const PDF_PAGE_ALLOWANCE = 5_000
/**
 * A PDF is taken as at least one page per this many bytes, whatever pages it shows. One whose pages can't be counted from
 * its bytes (pages packed in compressed object streams) is always counted, never trusted to the byte bound alone.
 */
export const PDF_BYTES_PER_PAGE_GUESS = 3_000

/** The fields `count_tokens` takes (its documented body). */
const COUNT_FIELDS = ['model', 'messages', 'system', 'tools', 'tool_choice', 'thinking', 'cache_control', 'output_config', 'speed'] as const

/**
 * Top-level fields refused outright: the MCP connector, priority capacity, code execution's container, and on-demand
 * server-side compaction. Server-side compaction runs a summary inside the call whose tokens the top-level usage leaves
 * out ("The top-level input_tokens and output_tokens do not include compaction iteration usage", compaction docs, read
 * 2026-11-20); design 8.2 compacts with the CLI's own auto-compact at 600,000, whose summary is an ordinary call, so the
 * server-side kind is never needed.
 */
const REFUSED_FIELDS = ['mcp_servers', 'service_tier', 'container', 'compaction'] as const

export type Inspected = {
  /** The body to send: `max_tokens` and `max_uses` clamped. */
  body: Record<string, unknown>
  maxTokens: number
  searchUses: number
  rate: InputRate
  modifiers: PriceModifiers
  /** 8.2 step 1, in tokens. */
  byteBound: number
  /** True when a PDF's pages were guessed: the byte bound alone is never trusted then. */
  mustCount: boolean
  /** The `count_tokens` body: the endpoint's fields only, server tools removed. */
  projection: Record<string, unknown>
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const utf8 = new TextEncoder()

/** A server tool: a tool with a `type` other than `custom` (client tools carry none, or `custom`). */
const isServerTool = (t: unknown) => isObj(t) && typeof t.type === 'string' && t.type !== 'custom'
const isWebSearch = (t: Record<string, unknown>) => typeof t.type === 'string' && /^web_search_\d{8}$/.test(t.type) && t.name === 'web_search'

/** Every object inside `v`, depth first. */
function* objects(v: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(v)) for (const x of v) yield* objects(x)
  else if (isObj(v)) {
    yield v
    for (const x of Object.values(v)) yield* objects(x)
  }
}

function base64Bytes(data: string): Uint8Array | null {
  try {
    const bin = atob(data)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** `/Type /Page` objects (not `/Pages`) in a PDF's raw bytes, or null when none are visible. */
export function pdfPages(bytes: Uint8Array): number | null {
  let text = ''
  for (let i = 0; i < bytes.length; i += 65_536) text += String.fromCharCode(...bytes.subarray(i, i + 65_536))
  const n = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0
  return n === 0 ? null : n
}

/**
 * Looks at one `/v1/messages` body. A refusal's text goes back to the CLI as a 400 `invalid_request_error`.
 * `price` is the body model's card (a modifier it has no price for is refused).
 */
export function inspectRequest(raw: unknown, price: Price): Inspected | { refused: string } {
  if (!isObj(raw)) return { refused: 'the body is not a JSON object' }
  for (const f of REFUSED_FIELDS) if (f in raw && raw[f] !== null && raw[f] !== undefined) return { refused: `${f} is not allowed` }
  if (!Array.isArray(raw.messages)) return { refused: 'messages is required' }
  // Context management: the clear_* edits (they only drop content) pass; compaction (`compact_*`) is refused.
  if (raw.context_management !== undefined && raw.context_management !== null) {
    const edits = isObj(raw.context_management) ? raw.context_management.edits : undefined
    if (edits !== undefined && !Array.isArray(edits)) return { refused: 'context_management.edits must be a list' }
    for (const e of edits ?? []) {
      if (!isObj(e) || typeof e.type !== 'string') return { refused: 'a context_management edit has no type' }
      if (e.type.startsWith('compact')) return { refused: `context_management edit ${e.type} is not allowed` }
    }
  }
  const asked = raw.max_tokens
  if (typeof asked !== 'number' || !Number.isSafeInteger(asked) || asked < 1) return { refused: 'max_tokens must be a positive integer' }
  const maxTokens = Math.min(asked, MAX_OUTPUT_TOKENS)

  // Modifiers: fast mode and geo only when the card prices them.
  if (raw.speed !== undefined && raw.speed !== null && raw.speed !== 'standard' && raw.speed !== 'fast') return { refused: 'speed has a value the gate has no price for' }
  if (raw.inference_geo !== undefined && raw.inference_geo !== null && typeof raw.inference_geo !== 'string') return { refused: 'inference_geo must be a string' }
  const modifiers: PriceModifiers = { fast: raw.speed === 'fast', geo: typeof raw.inference_geo === 'string' ? raw.inference_geo : null }
  if (!multipliersOf(price, modifiers)) return { refused: 'speed or inference_geo has a value the gate has no price for' }

  // Tools: client tools and web search only; web search capped at 5 uses.
  let searchUses = 0
  let tools: unknown[] | undefined
  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) return { refused: 'tools must be a list' }
    tools = []
    for (const t of raw.tools) {
      if (!isServerTool(t)) {
        tools.push(t)
        continue
      }
      const tool = t as Record<string, unknown>
      if (!isWebSearch(tool)) return { refused: `server tool ${String(tool.type)} is not allowed` }
      const given = tool.max_uses
      if (given !== undefined && (typeof given !== 'number' || !Number.isSafeInteger(given) || given < 1)) return { refused: 'web_search max_uses must be a positive integer' }
      const uses = Math.min(given ?? MAX_SEARCH_USES, MAX_SEARCH_USES)
      searchUses += uses
      tools.push({ ...tool, max_uses: uses })
    }
  }

  // Sources, cache TTLs and the byte bound's allowances, over everything the request carries.
  let rate: InputRate = 'input'
  let images = 0
  let pdfPageCount = 0
  let mustCount = false
  for (const o of objects([raw.system, raw.messages, raw.tools, raw.cache_control])) {
    if (o.type === 'container_upload') return { refused: 'container uploads are not allowed' }
    if ((o.type === 'image' || o.type === 'document') && isObj(o.source)) {
      const st = o.source.type
      if (st === 'url' || st === 'file') return { refused: `${String(o.type)} sources of type ${st} are not allowed` }
      if (o.type === 'image') images++
      if (o.type === 'document' && st === 'base64') {
        const bytes = typeof o.source.data === 'string' ? base64Bytes(o.source.data) : null
        if (!bytes) return { refused: 'a document is not valid base64' }
        // Visible pages can be a decoy (one `/Type /Page` in a comment, the rest in object streams): the size guess is a
        // floor either way.
        const pages = pdfPages(bytes)
        if (pages === null) mustCount = true
        pdfPageCount += Math.max(pages ?? 0, 1, Math.ceil(bytes.length / PDF_BYTES_PER_PAGE_GUESS))
      }
    }
    if ('cache_control' in o && o.cache_control !== null && o.cache_control !== undefined) {
      const cc = o.cache_control
      const ttl = isObj(cc) ? cc.ttl : undefined
      if (ttl === '1h') rate = 'cacheWrite1h'
      else if (ttl === undefined || ttl === '5m') {
        if (rate === 'input') rate = 'cacheWrite5m'
      } else return { refused: 'cache_control has a ttl the gate has no price for' }
    }
  }
  if (isObj(raw.cache_control)) {
    const ttl = raw.cache_control.ttl
    if (ttl === '1h') rate = 'cacheWrite1h'
    else if (ttl === undefined || ttl === '5m') {
      if (rate === 'input') rate = 'cacheWrite5m'
    } else return { refused: 'cache_control has a ttl the gate has no price for' }
  }

  const body: Record<string, unknown> = { ...raw, max_tokens: maxTokens }
  if (tools) body.tools = tools

  // The byte bound: the text the request carries as UTF-8 (its JSON, an upper bound on the text), base64 payloads out
  // and replaced by the fixed allowances.
  const blanked = JSON.stringify({ system: raw.system, messages: raw.messages, tools, tool_choice: raw.tool_choice, thinking: raw.thinking, output_config: raw.output_config }, (_k, v: unknown) =>
    isObj(v) && v.type === 'base64' && typeof v.data === 'string' ? { ...v, data: '' } : v)
  const byteBound = utf8.encode(blanked).length + images * IMAGE_ALLOWANCE + pdfPageCount * PDF_PAGE_ALLOWANCE

  const projection: Record<string, unknown> = {}
  for (const f of COUNT_FIELDS) if (body[f] !== undefined) projection[f] = body[f]
  if (tools) {
    const clientTools = tools.filter(t => !isServerTool(t))
    if (clientTools.length > 0) projection.tools = clientTools
    else delete projection.tools
  }

  return { body, maxTokens, searchUses, rate, modifiers, byteBound, mustCount, projection }
}
