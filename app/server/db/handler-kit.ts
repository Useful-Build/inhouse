// What the members and settings handlers share: the context they read (the part of server/routes.ts's
// `HandlerContext` they use), the body and query parsing (400 `invalid`) and the keyset cursor (p2-design section 5).
import type { z } from 'zod'
import { PageRequestSchema } from '../../shared/contract/paging.ts'
import { apiError } from '../http.ts'
import type { At } from './members.ts'
import type { HandlerContext } from '../routes.ts'
import type { Stores } from './stores.ts'

export type ApiCtx = Pick<HandlerContext, 'request' | 'principal' | 'params' | 'requestId' | 'nowMs' | 'stores' | 'access'>

/**
 * The request's stores as W2's `Stores` (server/index.ts passes `openStores`, a superset of `AuthStores`). Fails loud
 * when the route has none or they aren't W2's.
 */
export function storesOf(c: Pick<ApiCtx, 'stores'>): Stores {
  const s = c.stores
  if (!s || !('settings' in s)) throw new Error("this route has no stores, or they aren't the D1 stores")
  return s as Stores
}

/** The member id a write is made by. Every route that writes allows only principals with a member row. */
export function writer(c: ApiCtx): At {
  const p = c.principal
  if (p.kind === 'service' && (p.name === 'monitor' || p.name === 'release')) throw new Error(`${p.name} writes nothing here`)
  return { actorId: p.memberId, requestId: c.requestId, nowMs: c.nowMs }
}

/** The bodies these routes take are small; anything past this many bytes is refused. */
export const MAX_BODY_BYTES = 16 * 1024

/**
 * The body's bytes, read from the stream and counted as they arrive: null past `max` bytes, whatever `Content-Length`
 * says or whether it's sent at all (a chunked body has none). Stops reading at the cap.
 */
export async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get('Content-Length')
  if (declared !== null && Number(declared) > max) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

/** The JSON body parsed by `schema`, or the 400 `invalid` answer (over the cap, not UTF-8, not JSON, or off-schema). */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<{ ok: z.infer<S> } | { error: Response }> {
  const bytes = await readCapped(request, MAX_BODY_BYTES)
  if (bytes === null) return { error: apiError('invalid') }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { error: apiError('invalid') }
  }
  const parsed = schema.safeParse(json)
  return parsed.success ? { ok: parsed.data } : { error: apiError('invalid') }
}

/** The query string parsed by `schema` (every parameter, so an unknown one is refused by a strict schema), or 400. */
export function readQuery<S extends z.ZodType>(request: Request, schema: S): { ok: z.infer<S> } | { error: Response } {
  const params = new URL(request.url).searchParams
  const query: Record<string, string> = {}
  for (const [k, v] of params) {
    if (Object.hasOwn(query, k)) return { error: apiError('invalid') }
    query[k] = v
  }
  const parsed = schema.safeParse(query)
  return parsed.success ? { ok: parsed.data } : { error: apiError('invalid') }
}

const toBase64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** The opaque cursor for a page that ended at `key`. */
export const encodeCursor = (key: string): string => toBase64url(key)

/** The key a cursor names, or null when it isn't one of ours. */
export function decodeCursor(cursor: string): string | null {
  try {
    const bin = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))
    const key = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, ch => ch.charCodeAt(0)))
    return encodeCursor(key) === cursor ? key : null
  } catch {
    return null
  }
}

/** `?limit=&cursor=` as a page request: the limit (1 to 100, default 50) and the key to start after. */
export function readPage(request: Request): { ok: { limit: number; after: string | null } } | { error: Response } {
  const q = readQuery(request, PageRequestSchema)
  if ('error' in q) return q
  if (q.ok.cursor === undefined) return { ok: { limit: q.ok.limit, after: null } }
  const after = decodeCursor(q.ok.cursor)
  return after === null ? { error: apiError('invalid') } : { ok: { limit: q.ok.limit, after } }
}
