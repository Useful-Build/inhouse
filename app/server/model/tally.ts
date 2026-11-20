// The usage tally of one model call (p3-design 8.3). A JSON response's `usage` is taken as it is. In a stream,
// `message_start.message.usage` and each `message_delta.usage` are cumulative per field (streaming docs, read
// 2026-11-20: "The token counts shown in the `usage` field of the `message_delta` event are *cumulative*"), so each
// field keeps the last value it was given, never a sum. The real output count comes only with the final
// `message_delta`; a stream that ends without `message_stop` is cut (8.3 prices it at its worst case).
import type { TokenUsage } from './pricing.ts'

/** The usage fields a response can carry, each the last value seen. */
interface Fields {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  ephemeral_5m_input_tokens?: number
  ephemeral_1h_input_tokens?: number
  web_search_requests?: number
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined)

/** Takes every field `usage` carries into `into`, the newer value winning. */
function take(into: Fields, usage: unknown): void {
  if (typeof usage !== 'object' || usage === null) return
  const u = usage as Record<string, unknown>
  const set = (k: keyof Fields, v: unknown) => {
    const n = count(v)
    if (n !== undefined) into[k] = n
  }
  set('input_tokens', u.input_tokens)
  set('output_tokens', u.output_tokens)
  set('cache_creation_input_tokens', u.cache_creation_input_tokens)
  set('cache_read_input_tokens', u.cache_read_input_tokens)
  const cc = u.cache_creation as Record<string, unknown> | null | undefined
  if (typeof cc === 'object' && cc !== null) {
    set('ephemeral_5m_input_tokens', cc.ephemeral_5m_input_tokens)
    set('ephemeral_1h_input_tokens', cc.ephemeral_1h_input_tokens)
  }
  const st = u.server_tool_use as Record<string, unknown> | null | undefined
  if (typeof st === 'object' && st !== null) set('web_search_requests', st.web_search_requests)
  // Defence for server-side compaction (refused at the gate): the top-level counts leave a compaction iteration out, so
  // when `iterations` is there each token field is its sum over the iterations (or the top-level value, if higher).
  // Compaction docs (read 2026-11-20): "sum across all entries in the usage.iterations array".
  const iterations: unknown = u.iterations
  if (Array.isArray(iterations)) {
    const sum = (pick: (it: Record<string, unknown>) => unknown) =>
      iterations.reduce((acc: number, it: unknown) => acc + (typeof it === 'object' && it !== null ? (count(pick(it as Record<string, unknown>)) ?? 0) : 0), 0)
    const cc = (it: Record<string, unknown>) => (typeof it.cache_creation === 'object' && it.cache_creation !== null ? it.cache_creation as Record<string, unknown> : {})
    const atLeast = (k: keyof Fields, v: number) => void (into[k] = Math.max(into[k] ?? 0, v))
    atLeast('input_tokens', sum(it => it.input_tokens))
    atLeast('output_tokens', sum(it => it.output_tokens))
    atLeast('cache_creation_input_tokens', sum(it => it.cache_creation_input_tokens))
    atLeast('cache_read_input_tokens', sum(it => it.cache_read_input_tokens))
    atLeast('ephemeral_5m_input_tokens', sum(it => cc(it).ephemeral_5m_input_tokens))
    atLeast('ephemeral_1h_input_tokens', sum(it => cc(it).ephemeral_1h_input_tokens))
  }
}

/**
 * The fields as priced usage. Cache writes split by `cache_creation` when it's there; any write tokens it doesn't
 * account for are priced as 1-hour writes (the higher rate: a split the response didn't give never under-prices).
 */
function toUsage(f: Fields): TokenUsage {
  const w5 = f.ephemeral_5m_input_tokens ?? 0
  const w1 = f.ephemeral_1h_input_tokens ?? 0
  const unsplit = Math.max(0, (f.cache_creation_input_tokens ?? 0) - w5 - w1)
  return {
    inputTokens: f.input_tokens ?? 0,
    outputTokens: f.output_tokens ?? 0,
    cacheWrite5mTokens: w5,
    cacheWrite1hTokens: w1 + unsplit,
    cacheReadTokens: f.cache_read_input_tokens ?? 0,
    webSearches: f.web_search_requests ?? 0,
  }
}

const isUsage = (u: unknown) => typeof u === 'object' && u !== null && !Array.isArray(u)

/** A whole JSON response's usage (a `message` object), or null when it carries none (the caller prices it as cut). */
export function usageOfMessage(body: unknown): TokenUsage | null {
  const usage = typeof body === 'object' && body !== null ? (body as { usage?: unknown }).usage : undefined
  if (!isUsage(usage)) return null
  const f: Fields = {}
  take(f, usage)
  return toUsage(f)
}

export interface SseTally {
  /** Feed the next bytes of the stream, as they pass to the caller. */
  push(chunk: Uint8Array): void
  /** The usage so far (each field's last value). */
  usage(): TokenUsage
  /** True once `message_stop` arrived: the final `message_delta` (and its output count) came before it. */
  readonly complete: boolean
  /** True once any event carried a usage object (a stream that never did is priced as cut). */
  readonly sawUsage: boolean
  /** True once a `message_delta` carried usage: the final output count (a stream without one is priced as cut). */
  readonly sawFinalUsage: boolean
}

/** A tally over a Messages API event stream (`text/event-stream`). */
export function createSseTally(): SseTally {
  const decoder = new TextDecoder()
  const fields: Fields = {}
  let buffer = ''
  let complete = false
  let sawUsage = false
  let sawFinalUsage = false

  const onEvent = (block: string) => {
    const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
    if (data === '') return
    let event: { type?: unknown; message?: { usage?: unknown }; usage?: unknown }
    try {
      event = JSON.parse(data) as typeof event
    } catch {
      return
    }
    const usage = event.type === 'message_start' ? event.message?.usage : event.type === 'message_delta' ? event.usage : undefined
    if (isUsage(usage)) {
      sawUsage = true
      if (event.type === 'message_delta') sawFinalUsage = true
      take(fields, usage)
    }
    if (event.type === 'message_start' || event.type === 'message_delta') return
    if (event.type === 'message_stop') complete = true
    else if (event.type === 'error') complete = false
  }

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buffer)
        if (!m) break
        onEvent(buffer.slice(0, m.index))
        buffer = buffer.slice(m.index + m[0].length)
      }
    },
    usage: () => toUsage(fields),
    get complete() {
      return complete
    },
    get sawUsage() {
      return sawUsage
    },
    get sawFinalUsage() {
      return sawFinalUsage
    },
  }
}
