// The real client's one way to the Worker (p2-design.md sections 4 and 11): same-origin `fetch`, JSON in and out, every
// answer turned into a value that parsed through its shared schema or an `AgentError`. No retries. A body that doesn't
// parse is an `unknown` error with the schema's message logged, never passed on.
import type { z } from 'zod'
import { NOT_FOUND, RATE_LIMITED } from '../../../shared/contract/error-codes'
import { AgentError } from '../types'
import type { AgentErrorCode } from '../types'

/** The schemas, loaded on first use (schemas.ts says why): zod stays out of the entry's first load. */
export type Contract = typeof import('./schemas')
export type Answer = keyof Contract['ANSWERS']
const loadContract = (): Promise<Contract> => import('./schemas')

export interface TransportOptions {
  /** Prepended to every path: empty in the browser (same origin), the test build's origin under Node. */
  origin?: string
  fetch?: typeof fetch
  /** Extra headers per request. Under Node the contract target puts `Cf-Access-Jwt-Assertion` and `Origin` here, as Access and the browser would. */
  headers?: () => Promise<Record<string, string>> | Record<string, string>
  /** How long a request may take before it is given up (ms). 30 s: longer than any Worker and D1 round trip takes, short enough that a write queued behind a hung one isn't held for minutes. */
  timeoutMs?: number
  /** How the schemas chunk loads (a test makes it fail). */
  loadContract?: () => Promise<Contract>
}

/** What a person is told for each code, when the server gave no better words. */
export const MESSAGE: Record<AgentErrorCode, string> = {
  offline: "You're offline. Check your connection and try again.",
  forbidden: "You can't do that.",
  conflict: 'Someone changed this first.',
  [NOT_FOUND]: "That isn't there any more.",
  unavailable: "We couldn't save that. Try again in a moment.",
  unknown: 'Something went wrong. Try again.',
  unauthorized: 'Your sign-in has ended. Sign in again.',
  [RATE_LIMITED]: 'Too many requests. Try again in a moment.',
  cap_reached: 'The monthly cap is reached.',
  invalid: "That isn't allowed. Check it and try again.",
}

const CODE_BY_STATUS: Record<number, AgentErrorCode> = {
  400: 'invalid', 401: 'unauthorized', 403: 'forbidden', 404: NOT_FOUND, 409: 'conflict', 429: RATE_LIMITED, 503: 'unavailable',
}

export interface Call<K extends Answer> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  /** Which schema parses the answer. */
  schema: K
  /** A JSON body, built from the shared schema by the caller. */
  json?: unknown
  /** Raw bytes with their type (the photo), or a `File` the browser streams (an attachment). */
  bytes?: { data: Uint8Array | Blob; type: string }
  /** Extra request headers for this call (an upload's `X-File-Name`). */
  headers?: Record<string, string>
  /** Cancels the request: it rejects with `UploadCancelled` and a request not yet sent is never sent. */
  signal?: AbortSignal
  /** This call's time limit in place of the transport's (an upload of a big file on a slow line). */
  timeoutMs?: number
}

/** A call the caller cancelled with its `signal`. Not a failure to tell the person about. */
export class UploadCancelled extends Error {
  constructor() { super('Cancelled.'); this.name = 'UploadCancelled' }
}

export class Transport {
  private readonly origin: string
  private readonly doFetch: typeof fetch
  private readonly extra: TransportOptions['headers']
  private readonly timeoutMs: number
  constructor(o: TransportOptions = {}) {
    this.origin = o.origin ?? ''
    // `fetch` called through the globalThis binding: a bare reference loses its receiver in some browsers.
    this.doFetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.extra = o.headers
    this.timeoutMs = o.timeoutMs ?? 30_000
    this.contract = o.loadContract ?? loadContract
  }

  /** The schemas (once loaded, `import()` answers at once). */
  contract: () => Promise<Contract>

  /** The answer, parsed through `schema`; rejects with an `AgentError` for every failure. */
  async call<K extends Answer>(c: Call<K>): Promise<z.infer<Contract['ANSWERS'][K]>> {
    // A chunk that won't load is a fault of the client: `unavailable`, and the handler is attached at once (no unhandled rejection).
    const k = this.contract().catch((e: unknown): never => {
      console.error('Inhouse: the schemas chunk did not load.', e)
      throw new AgentError('unavailable', MESSAGE.unavailable)
    })
    k.catch(() => undefined)
    // A write waits for the schemas before it is sent: it must not be saved by a server and then taken back for want of a parser.
    if (c.method !== 'GET') await k
    if (c.signal?.aborted) throw new UploadCancelled()
    const body = await this.send(c.method, c.path, c.json, c.bytes, k, c.headers, c.signal, c.timeoutMs)
    const parsed = (await k).ANSWERS[c.schema].safeParse(body) as z.ZodSafeParseResult<z.infer<Contract['ANSWERS'][K]>>
    if (!parsed.success) {
      console.error(`Inhouse: ${c.method} ${c.path} answered something its schema refuses: ${parsed.error.message}`)
      throw new AgentError('unknown', MESSAGE.unknown)
    }
    return parsed.data
  }

  /**
   * A GET whose answer is a file: its bytes and its `Content-Disposition`, with the same sign-in, timeout and refusals as
   * `call`. The schemas load only for a refusal, so a download never waits for them.
   */
  async download(path: string): Promise<{ blob: Blob; disposition: string | null }> {
    const headers: Record<string, string> = { Accept: '*/*', ...(await this.extra?.()) }
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctl.abort() }, this.timeoutMs)
    try {
      let res: Response
      try {
        res = await this.doFetch(this.origin + path, { method: 'GET', headers, credentials: 'same-origin', redirect: 'manual', signal: ctl.signal })
      } catch {
        throw timedOut ? new AgentError('unavailable', MESSAGE.unavailable) : new AgentError('offline', MESSAGE.offline)
      }
      if (res.type === 'opaqueredirect') throw new AgentError('unauthorized', MESSAGE.unauthorized)
      if (!res.ok) await this.answer(res, await res.text().catch(() => ''), this.contract())
      const blob = await res.blob().catch((): never => { throw new AgentError(timedOut ? 'unavailable' : 'offline', timedOut ? MESSAGE.unavailable : MESSAGE.offline) })
      return { blob, disposition: res.headers.get('Content-Disposition') }
    } finally { clearTimeout(timer) }
  }

  private async send(method: string, path: string, json: unknown, bytes: Call<Answer>['bytes'], k: Promise<Contract>, extraHeaders?: Record<string, string>, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(await this.extra?.()), ...extraHeaders }
    let body: BodyInit | undefined
    if (bytes) { headers['Content-Type'] = bytes.type; body = bytes.data as BodyInit } else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json) }
    // A request that never answers is given up: a write waiting behind it (its record's queue) would otherwise wait for ever.
    // The timer is `setTimeout`, not `AbortSignal.timeout`, so a test with fake timers can move it on.
    const ctl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctl.abort() }, timeoutMs ?? this.timeoutMs)
    const cancel = () => ctl.abort()
    signal?.addEventListener('abort', cancel, { once: true })
    // Aborted while the schemas or the headers were awaited: the listener missed it.
    if (signal?.aborted) ctl.abort()
    try {
      let res: Response
      try {
        res = await this.doFetch(this.origin + path, { method, headers, body, credentials: 'same-origin', redirect: 'manual', signal: ctl.signal })
      } catch {
        if (signal?.aborted) throw new UploadCancelled()
        // Nothing came back: a timeout is the server not answering (told as `unavailable`, as a 5xx is), anything else is the connection.
        throw timedOut ? new AgentError('unavailable', MESSAGE.unavailable) : new AgentError('offline', MESSAGE.offline)
      }
      // Access answering with a redirect to its login page: the sign-in is gone.
      if (res.type === 'opaqueredirect') throw new AgentError('unauthorized', MESSAGE.unauthorized)
      const text = await res.text().catch(() => '')
      if (timedOut) throw new AgentError('unavailable', MESSAGE.unavailable)
      return await this.answer(res, text, k)
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel) }
  }

  private async answer(res: Response, text: string, k: Promise<Contract>): Promise<unknown> {
    let data: unknown
    try { data = text ? JSON.parse(text) : undefined } catch { data = undefined }
    if (res.ok) return data
    // An error answer: the body names the code when it is ours; a 5xx or a page from in front of the Worker is told by status.
    const err = (await k).ErrorBodySchema.safeParse(data)
    if (err.success) {
      const { code, reason, current } = err.data.error
      throw new AgentError(code, MESSAGE[code], { reason, current })
    }
    const code = CODE_BY_STATUS[res.status] ?? 'unknown'
    throw new AgentError(code, MESSAGE[code])
  }
}
