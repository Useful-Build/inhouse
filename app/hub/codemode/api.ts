// The one object a script can reach (P5 W2, A.3): `graphql(query, variables)` over the Shopify SignIn, nothing else.
// Plain logic so the Node project tests it; run.ts wraps it in an RpcTarget whose only method is `graphql`.
// - One call in flight at a time: a call made while another runs waits its turn, so `Promise.all` over 10 calls can't
//   pull 10 responses into hub memory at once.
// - At most MAX_CALLS calls and MAX_READ_BYTES read in all; the call that crosses either throws.
// - Closed when the run settles or its deadline fires: every later or queued call is refused without reaching SignIn.
// - A refusal is an Error whose message is the fixed HubError text for its code, never an upstream body.
import type { HubError, HubResult } from '../index/contract'
import { hubError } from '../index/errors'
import { FIELD_NOT_ALLOWED } from '../scope/fields'
import { MAX_CALLS, MAX_READ_BYTES } from './caps'

/** What ScriptApi calls: the Shopify read client (the SignIn stub's `query`). */
export type ScriptClient = {
  graphql(document: string, variables?: Record<string, unknown>, apiVersion?: string): Promise<HubResult<{ data: unknown }>>
}

export const CLOSED_MESSAGE = 'shop is closed: the script has finished or ran out of time'
export const CALLS_MESSAGE = `at most ${MAX_CALLS} shop.graphql calls per script`
export const BYTES_MESSAGE = `at most ${MAX_READ_BYTES / (1024 * 1024)} MiB read per script; ask for fewer fields or nodes`

/** The fixed text for a HubError: its code's text, plus `field not allowed` (the one detail a script needs). */
export function scriptErrorText(e: HubError): string {
  const withField = hubError('invalid_args', FIELD_NOT_ALLOWED).message
  const text = e.code === 'invalid_args' && e.message === withField ? withField : hubError(e.code).message
  return `${e.code}: ${text}`
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const jsonBytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v) ?? 'null').byteLength

export type ScriptApiHooks = {
  /** Called when a call is refused because the object is closed (tests await it instead of waiting). */
  refused?: () => void
}

export class ScriptApi {
  readonly #client: ScriptClient
  readonly #apiVersion: string
  readonly #hooks: ScriptApiHooks
  #calls = 0
  #bytes = 0
  #closed = false
  #tail: Promise<unknown> = Promise.resolve()

  constructor(client: ScriptClient, apiVersion: string, hooks: ScriptApiHooks = {}) {
    this.#client = client
    this.#apiVersion = apiVersion
    this.#hooks = hooks
  }

  get calls(): number {
    return this.#calls
  }
  get bytes(): number {
    return this.#bytes
  }
  get closed(): boolean {
    return this.#closed
  }

  close(): void {
    this.#closed = true
  }

  graphql(query: unknown, variables?: unknown): Promise<{ data: unknown }> {
    if (this.#closed) return Promise.reject(this.#refusedClosed())
    if (++this.#calls > MAX_CALLS) return Promise.reject(new Error(CALLS_MESSAGE))
    if (typeof query !== 'string') return Promise.reject(new Error(scriptErrorText(hubError('invalid_args'))))
    if (variables !== undefined && !isPlainObject(variables)) return Promise.reject(new Error(scriptErrorText(hubError('invalid_args'))))
    const turn = this.#tail.then(() => this.#send(query, variables))
    this.#tail = turn.catch(() => {})
    return turn
  }

  #refusedClosed(): Error {
    this.#hooks.refused?.()
    return new Error(CLOSED_MESSAGE)
  }

  async #send(query: string, variables: Record<string, unknown> | undefined): Promise<{ data: unknown }> {
    if (this.#closed) throw this.#refusedClosed()
    const r = await this.#client.graphql(query, variables, this.#apiVersion)
    // An answer that lands after the deadline is dropped.
    if (this.#closed) throw this.#refusedClosed()
    if (!r.ok) throw new Error(scriptErrorText(r.error))
    this.#bytes += jsonBytes(r.value.data)
    if (this.#bytes > MAX_READ_BYTES) throw new Error(BYTES_MESSAGE)
    return { data: r.value.data }
  }
}
