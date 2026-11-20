// The model route (p3-design 8.2 and 8.3): the spend gate's egress side. `POST /model/v1/messages` is checked, priced at
// its worst case, admitted by the BrandAgent, confirmed with one renew, sent upstream once, leased (renewed every 20 s
// with its running usage) and closed exactly once from a `finally` that also runs when the caller goes away.
// `POST /model/v1/messages/count_tokens` (the CLI's own counts) passes unpriced, at most 50 per turn.
import { CATALOG, resolveModel } from '../model/catalog.ts'
import type { Price } from '../model/catalog.ts'
import { priceUsage, priceWorst } from '../model/pricing.ts'
import type { PriceModifiers, TokenUsage } from '../model/pricing.ts'
import { INPUT_BOUND, inspectRequest, SEARCH_INPUT_ALLOWANCE } from '../model/request.ts'
import type { Inspected } from '../model/request.ts'
import { createSseTally, usageOfMessage } from '../model/tally.ts'
import type { ModelCallUsage, ModelCallWorst } from '../do/brand-agent/ports.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import type { EgressDeps } from './deps.ts'
import { mapUpstreamError, messagesError, modelRequestHeaders, parseJson, readCapped, responseHeaders } from './http.ts'

/** The largest request body the model route takes (8.2). */
export const MODEL_BODY_MAX_BYTES = 32 * 1024 * 1024
/** The start hold every turn reserves (design 9): a byte-bound worst case at or under it is never counted (8.2). */
export const START_HOLD_MICRO = 250_000
/** The count's margin (8.2 step 2): `ceil(count × 1.1) + 1,000`. */
export const countedInput = (count: number) => Math.ceil(count * 1.1) + 1_000
/** How long the gate's own count may take before the call is 503 (8.2 step 2). */
export const COUNT_TIMEOUT_MS = 5_000
/** How often a running call renews its 60 s lease (8.2, N1). */
export const RENEW_EVERY_MS = 20_000
/**
 * How long the upstream may take to answer with its headers. A stream's headers come with `message_start`, before any
 * output, so 2 minutes is ample even when the API queues; a non-streamed answer arrives whole, and 32,000 output tokens
 * at a slow rate take minutes, so it gets the Anthropic SDKs' own default request timeout, 10 minutes. Past it the call
 * is closed cut, so a stalled gateway can't hold one of the turn's 4 slots and its worst case until the turn ends.
 */
export const FIRST_BYTE_TIMEOUT_MS = { stream: 120_000, whole: 600_000 } as const
/**
 * How long a stream may go without a byte. The API sends `ping` events while it works and thinking streams its own
 * deltas, so 5 minutes of silence is a dead stream, not a slow one; closed cut.
 */
export const STREAM_IDLE_TIMEOUT_MS = 300_000

const ZERO: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, webSearches: 0 }

export async function modelRoute(request: Request, path: string, grant: RunGrant, d: EgressDeps): Promise<Response> {
  if (request.method !== 'POST') return messagesError(405, 'invalid_request_error', 'Only POST is allowed here.')
  const isCount = path === '/model/v1/messages/count_tokens'
  if (!isCount && path !== '/model/v1/messages') return messagesError(404, 'not_found_error', 'No such model endpoint.')

  const bytes = await readCapped(request, MODEL_BODY_MAX_BYTES)
  if (bytes === null) return messagesError(413, 'request_too_large', 'The request is over 32 MB.')
  const body = parseJson(bytes)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return messagesError(400, 'invalid_request_error', 'The body is not a JSON object.')
  const model = (body as { model?: unknown }).model
  if (typeof model !== 'string' || (model !== grant.model && model !== grant.sideModel)) {
    return messagesError(403, 'permission_error', 'This turn may not use that model.')
  }
  // The switched-off model (item 13): W1's resolveModel decides, from the brand's settings as they are now.
  const entry = CATALOG.find(m => m.apiId === model)
  const resolved = entry ? resolveModel(entry.id, await d.settings()) : null
  if (!entry || !resolved || 'refused' in resolved) return messagesError(403, 'permission_error', 'model_off')
  const price = entry.price as Price

  const headers = modelRequestHeaders(request.headers)
  if (!(headers instanceof Headers)) return messagesError(400, 'invalid_request_error', `anthropic-beta ${headers.refusedBeta.slice(0, 80)} is not allowed`)
  if (isCount) return cliCount(body, headers, grant, d)
  return messages(request, body, model, headers, grant, price, d)
}

/** The CLI's own `count_tokens`: unpriced, at most 50 per turn (the BrandAgent counts), then 400. */
async function cliCount(body: object, headers: Headers, grant: RunGrant, d: EgressDeps): Promise<Response> {
  if (!(await d.rpc.noteCountTokens(grant.turnId))) return messagesError(400, 'invalid_request_error', 'count_tokens limit for this turn reached')
  let res: Response
  try {
    res = await d.upstream('/v1/messages/count_tokens', { body: JSON.stringify(body), headers, signal: AbortSignal.timeout(COUNT_TIMEOUT_MS) })
  } catch {
    return messagesError(503, 'api_error', 'The model service did not answer.')
  }
  return passBack(res)
}

/** An upstream answer that carries no usage (a count): its JSON whole, or its error mapped. */
async function passBack(res: Response): Promise<Response> {
  const h = responseHeaders(res.headers)
  if (res.status >= 300 && res.status < 400) return messagesError(502, 'api_error', 'The model service redirected.')
  if (!res.ok) return mapUpstreamError(res, h)
  return new Response(await res.arrayBuffer(), { status: res.status, headers: h })
}

/** The gate's own count of the projection: the tokens, or `fallback` (a 4xx: keep the byte bound), or `unavailable`. */
async function countProjection(projection: object, headers: Headers, d: EgressDeps): Promise<number | 'fallback' | 'unavailable'> {
  try {
    const res = await d.upstream('/v1/messages/count_tokens', { body: JSON.stringify(projection), headers, signal: AbortSignal.timeout(COUNT_TIMEOUT_MS) })
    if (res.status >= 400 && res.status < 500) {
      await res.body?.cancel()
      return 'fallback'
    }
    if (!res.ok) {
      await res.body?.cancel()
      return 'unavailable'
    }
    const n = ((await res.json()) as { input_tokens?: unknown }).input_tokens
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** The worst case of a call (8.2 steps 1-4), or the answer that refuses it before admission. */
export async function worstCase(insp: Inspected, model: string, price: Price, headers: Headers, d: EgressDeps): Promise<ModelCallWorst | Response> {
  const search = insp.searchUses * SEARCH_INPUT_ALLOWANCE
  const at = (input: number) => priceWorst(price, insp.modifiers, { inputTokens: input + search, rate: insp.rate, maxTokens: insp.maxTokens, searchUses: insp.searchUses })
  let input = insp.byteBound
  if (insp.mustCount || at(input) > START_HOLD_MICRO) {
    const counted = await countProjection(insp.projection, headers, d)
    if (counted === 'unavailable') return messagesError(503, 'api_error', 'The model service did not answer the token count.')
    if (counted !== 'fallback') input = countedInput(counted)
  }
  if (input > INPUT_BOUND) return messagesError(400, 'invalid_request_error', `The input is over the gate's ${INPUT_BOUND}-token bound.`)
  const modifiers: Record<string, string | number | boolean> = { rate: insp.rate, searchUses: insp.searchUses, fast: insp.modifiers.fast }
  if (insp.modifiers.geo !== null) modifiers.geo = insp.modifiers.geo
  return { model, inputTokens: input + search, maxTokens: insp.maxTokens, modifiers, micro: at(input) }
}

async function messages(request: Request, body: object, model: string, headers: Headers, grant: RunGrant, price: Price, d: EgressDeps): Promise<Response> {
  const insp = inspectRequest(body, price)
  if ('refused' in insp) return messagesError(400, 'invalid_request_error', insp.refused)
  const worst = await worstCase(insp, model, price, headers, d)
  if (worst instanceof Response) return worst

  const { turnId } = grant
  const callId = d.newCallId()
  const admitted = await d.rpc.admitModelCall(turnId, callId, worst)
  // Cancelled while waiting in the gate: no confirm, so an unconfirmed grant is freed at zero (revision 6, M2).
  if (request.signal.aborted) return messagesError(499, 'api_error', 'The caller went away.')
  if ('refused' in admitted) return messagesError(400, 'invalid_request_error', admitted.refused)
  if ('busy' in admitted) return messagesError(503, 'api_error', 'budget_wait')
  const confirmed = await d.rpc.renewModelCall(turnId, callId, { ...ZERO, micro: 0 })
  if ('gone' in confirmed) return messagesError(503, 'api_error', 'The call was closed before it started.')

  return new CallLease(request, turnId, callId, worst, price, insp.modifiers, d).run(insp.body, headers, insp.body.stream === true)
}

/**
 * How a call closes. `unsent`: no upstream request went out (a connect failure, the caller gone before the send), so
 * nothing was billed: zero, not cut. `tally`: the answer is whole and carried its usage: priced from it. `cut`: anything
 * else after the send (aborted, cancelled, timed out, lease gone, no final event, no usage): priced at the larger of its
 * admitted worst case (8.3) and its running tally (search results past the allowance can pass the worst case).
 */
type CloseKind = 'unsent' | 'tally' | 'cut'

/** One admitted, confirmed call: sent once, renewed every 20 s, closed exactly once. */
class CallLease {
  private closed: CloseKind | null = null
  private readonly upstreamAbort = new AbortController()
  private readonly done: Promise<void>
  private resolveDone!: () => void
  private timer: ReturnType<typeof setInterval> | undefined
  private usage: () => TokenUsage = () => ZERO
  /** True once the answer is whole and carried its usage: a late abort or cancel then closes from the tally. */
  private whole: () => boolean = () => false
  private readonly onAbort = () => void this.close(this.whole() ? 'tally' : 'cut')

  private readonly request: Request
  private readonly turnId: string
  private readonly callId: string
  private readonly worst: ModelCallWorst
  private readonly price: Price
  private readonly modifiers: PriceModifiers
  private readonly d: EgressDeps

  constructor(request: Request, turnId: string, callId: string, worst: ModelCallWorst, price: Price, modifiers: PriceModifiers, d: EgressDeps) {
    this.request = request
    this.turnId = turnId
    this.callId = callId
    this.worst = worst
    this.price = price
    this.modifiers = modifiers
    this.d = d
    this.done = new Promise(r => (this.resolveDone = r))
    // The close outlives the response (`waitUntil`), and runs when the caller drops its request.
    d.waitUntil(this.done)
    this.timer = d.setInterval(() => void this.renew(), RENEW_EVERY_MS)
  }

  private priced(u: TokenUsage): ModelCallUsage {
    return { ...u, micro: priceUsage(this.price, this.modifiers, u) }
  }

  private async renew(): Promise<void> {
    if (this.closed) return
    try {
      const a = await this.d.rpc.renewModelCall(this.turnId, this.callId, this.priced(this.usage()))
      // The lease closed the call: stop the upstream at once. The close still goes out (answered `gone`, priced once).
      if ('gone' in a) await this.close('cut')
    } catch (e) {
      this.d.log({ event: 'egress_renew_failed', route: 'model', error: e instanceof Error ? e.name : 'unknown' })
    }
  }

  /** Closes the call once (see `CloseKind`). */
  async close(kind: CloseKind): Promise<void> {
    if (this.closed) return
    this.closed = kind
    if (this.timer !== undefined) this.d.clearInterval(this.timer)
    this.request.signal.removeEventListener('abort', this.onAbort)
    if (kind === 'cut') this.upstreamAbort.abort()
    const tally = this.priced(this.usage())
    const usage = kind === 'unsent' ? { ...ZERO, micro: 0 } : kind === 'cut' ? { ...tally, micro: Math.max(this.worst.micro, tally.micro) } : tally
    try {
      await this.d.rpc.releaseModelCall(this.turnId, this.callId, { usage, cut: kind === 'cut' })
    } catch (e) {
      // The lease closes it instead (priced by the cut-stream rule).
      this.d.log({ event: 'egress_release_failed', route: 'model', error: e instanceof Error ? e.name : 'unknown' })
    } finally {
      this.resolveDone()
    }
  }

  /** The answer for a call this lease already closed (the caller gone, a timeout, the lease gone). */
  private closedAnswer(): Response {
    return this.request.signal.aborted ? messagesError(499, 'api_error', 'The caller went away.') : messagesError(504, 'api_error', 'The model service did not answer in time.')
  }

  async run(body: object, headers: Headers, stream: boolean): Promise<Response> {
    // Gone during the confirm, or before the send: nothing went upstream.
    if (this.request.signal.aborted) {
      await this.close('unsent')
      return messagesError(499, 'api_error', 'The caller went away.')
    }
    this.request.signal.addEventListener('abort', this.onAbort)
    const firstByte = this.d.setTimeout(() => {
      this.d.log({ event: 'egress_model_timeout', route: 'model', phase: 'first_byte' })
      void this.close('cut')
    }, stream ? FIRST_BYTE_TIMEOUT_MS.stream : FIRST_BYTE_TIMEOUT_MS.whole)
    let res: Response
    try {
      res = await this.d.upstream('/v1/messages', { body: JSON.stringify(body), headers, signal: this.upstreamAbort.signal })
    } catch {
      this.d.clearTimeout(firstByte)
      if (this.closed) return this.closedAnswer()
      // A connect failure: the request never reached the model.
      await this.close('unsent')
      return messagesError(502, 'api_error', 'The model service failed.')
    }
    this.d.clearTimeout(firstByte)
    if (this.closed) {
      await res.body?.cancel().catch(() => undefined)
      return this.closedAnswer()
    }
    const h = responseHeaders(res.headers)
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel()
      await this.close('tally')
      return messagesError(502, 'api_error', 'The model service redirected.')
    }
    if (!res.ok) {
      // An error answer bills nothing: closed at zero (an empty tally).
      const mapped = await mapUpstreamError(res, h)
      await this.close('tally')
      return mapped
    }
    const streamed = (res.headers.get('content-type') ?? '').includes('text/event-stream')
    if (!streamed) {
      try {
        const text = await res.text()
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          json = undefined
        }
        if (json === undefined) {
          await this.close('cut')
          return messagesError(502, 'api_error', 'The model service answered something unreadable.')
        }
        const usage = usageOfMessage(json)
        if (usage === null) {
          // A 200 with no usage can't be priced from itself: booked at the worst case, and logged.
          this.d.log({ event: 'egress_model_no_usage', route: 'model', shape: 'json' })
          await this.close('cut')
        } else {
          this.usage = () => usage
          await this.close('tally')
        }
        return new Response(text, { status: res.status, headers: h })
      } catch {
        await this.close('cut')
        return this.closed === 'cut' && this.request.signal.aborted ? this.closedAnswer() : messagesError(502, 'api_error', 'The model service failed.')
      }
    }
    return this.stream(res, h)
  }

  private stream(res: Response, h: Headers): Response {
    const tally = createSseTally()
    this.usage = () => tally.usage()
    this.whole = () => tally.complete && tally.sawUsage
    const reader = res.body!.getReader()
    const end = async () => {
      if (tally.complete && !tally.sawUsage) this.d.log({ event: 'egress_model_no_usage', route: 'model', shape: 'stream' })
      await this.close(this.whole() ? 'tally' : 'cut')
    }
    const out = new ReadableStream<Uint8Array>({
      pull: async c => {
        const idle = this.d.setTimeout(() => {
          this.d.log({ event: 'egress_model_timeout', route: 'model', phase: 'idle' })
          void this.close('cut')
          void reader.cancel().catch(() => undefined)
        }, STREAM_IDLE_TIMEOUT_MS)
        try {
          const { done, value } = await reader.read()
          this.d.clearTimeout(idle)
          // Cut while reading (the idle timer, the lease gone): the caller sees an error, never a clean end.
          if (this.closed === 'cut') {
            c.error(new Error('the model stream was cut'))
            return
          }
          if (done) {
            c.close()
            await end()
            return
          }
          tally.push(value)
          c.enqueue(value)
        } catch (e) {
          this.d.clearTimeout(idle)
          await this.close('cut')
          c.error(e)
        }
      },
      cancel: async () => {
        await this.close(this.whole() ? 'tally' : 'cut')
        await reader.cancel().catch(() => undefined)
      },
    })
    return new Response(out, { status: res.status, headers: h })
  }
}
