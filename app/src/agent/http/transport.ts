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
  /** Raw bytes with their type (the photo). */
  bytes?: { data: Uint8Array; type: string }
}

export class Transport {
  private readonly origin: string
  private readonly doFetch: typeof fetch
  private readonly extra: TransportOptions['headers']
  constructor(o: TransportOptions = {}) {
    this.origin = o.origin ?? ''
    // `fetch` called through the globalThis binding: a bare reference loses its receiver in some browsers.
    this.doFetch = o.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.extra = o.headers
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
    const body = await this.send(c.method, c.path, c.json, c.bytes, k)
    const parsed = (await k).ANSWERS[c.schema].safeParse(body) as z.ZodSafeParseResult<z.infer<Contract['ANSWERS'][K]>>
    if (!parsed.success) {
      console.error(`Inhouse: ${c.method} ${c.path} answered something its schema refuses: ${parsed.error.message}`)
      throw new AgentError('unknown', MESSAGE.unknown)
    }
    return parsed.data
  }

  private async send(method: string, path: string, json: unknown, bytes: Call<Answer>['bytes'], k: Promise<Contract>): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(await this.extra?.()) }
    let body: BodyInit | undefined
    if (bytes) { headers['Content-Type'] = bytes.type; body = bytes.data as BodyInit } else if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json) }
    let res: Response
    try {
      res = await this.doFetch(this.origin + path, { method, headers, body, credentials: 'same-origin', redirect: 'manual' })
    } catch {
      throw new AgentError('offline', MESSAGE.offline)
    }
    // Access answering with a redirect to its login page: the sign-in is gone.
    if (res.type === 'opaqueredirect') throw new AgentError('unauthorized', MESSAGE.unauthorized)
    const text = await res.text().catch(() => '')
    let data: unknown
    try { data = text ? JSON.parse(text) : undefined } catch { data = undefined }
    if (res.ok) return data
    // An error answer: the body names the code when it is ours; a 5xx or a page from in front of the Worker is told by status.
    const err = (await k).ErrorBodySchema.safeParse(data)
    if (err.success) {
      const { code, reason, current } = err.data.error
      throw new AgentError(code, MESSAGE[code], { ...(reason ? { reason } : {}), ...(current ? { current } : {}) })
    }
    const code = CODE_BY_STATUS[res.status] ?? 'unknown'
    throw new AgentError(code, MESSAGE[code])
  }
}
