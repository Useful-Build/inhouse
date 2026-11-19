// An in-memory stand-in for the Worker's store and files routes, behind the loopback proxy, as a `fetch`. Every request
// body is parsed through the shared protocol's schemas, so the adapters are held to the same contract W3 serves.
// Store parts are kept by part id and read back in part order, like an object store's sorted listing.
import { FileListing, StoreAppend, StoreListSubkeys, StoreLoad } from '../../../../shared/protocol/index.ts'
import type { Fetch } from '../../../src/store/adapter.ts'

export const PROXY_URL = 'http://127.0.0.1:8081'

type Init = Parameters<Fetch>[1]

export type FakeEgress = {
  fetch: Fetch
  /** Parts per key (JSON of the key), by part id. */
  parts: Map<string, Map<string, unknown[]>>
  /** The chat's files by path. */
  files: Map<string, { body: Uint8Array; contentType?: string }>
  /** Every request, as method and path. */
  calls: string[]
  /** Return a status to fail a request (after it's recorded), or null to serve it. */
  fail: (method: string, path: string, body: unknown) => number | null
  /** Called on every append the store accepts, before it answers (to hold one in flight). */
  onAppend: (part: string) => Promise<void> | void
  /** Accepted appends whose entries the store loses (answers 200, keeps nothing). */
  lose: Set<string>
  /** All entries stored for a key, in part order. */
  entries(key: { projectKey: string; sessionId: string; subpath?: string }): unknown[]
}

const keyOf = (k: { projectKey: string; sessionId: string; subpath?: string }) => JSON.stringify([k.projectKey, k.sessionId, k.subpath ?? null])

export function fakeEgress(): FakeEgress {
  const egress: FakeEgress = {
    parts: new Map(),
    files: new Map(),
    calls: [],
    fail: () => null,
    onAppend: () => {},
    lose: new Set(),
    entries(key) {
      const parts = egress.parts.get(keyOf(key))
      if (!parts) return []
      return [...parts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).flatMap(([, e]) => e)
    },
    async fetch(url: string, init: Init) {
      const u = new URL(url)
      if (u.origin !== PROXY_URL) throw new Error(`not the proxy: ${u.origin}`)
      const path = u.pathname
      const method = init.method
      egress.calls.push(`${method} ${path}`)
      const text = typeof init.body === 'string' ? init.body : undefined
      const json = text === undefined ? undefined : JSON.parse(text)
      const failed = egress.fail(method, path, json)
      if (failed !== null) return new Response('{"error":"failed"}', { status: failed })

      if (method === 'POST' && path === '/store/append') {
        const b = StoreAppend.parse(json)
        await egress.onAppend(b.part)
        if (egress.lose.has(b.part)) return Response.json({ ok: true })
        const parts = egress.parts.get(keyOf(b.key)) ?? new Map<string, unknown[]>()
        parts.set(b.part, b.entries)
        egress.parts.set(keyOf(b.key), parts)
        return Response.json({ ok: true })
      }
      if (method === 'POST' && path === '/store/load') {
        const { key } = StoreLoad.parse(json)
        return Response.json({ entries: egress.parts.has(keyOf(key)) ? egress.entries(key) : null })
      }
      if (method === 'POST' && path === '/store/list-subkeys') {
        const { key } = StoreListSubkeys.parse(json)
        const subkeys = [...egress.parts.keys()].map((k) => JSON.parse(k) as [string, string, string | null]).filter(([p, s, sub]) => p === key.projectKey && s === key.sessionId && sub !== null)
        return Response.json({ subkeys: subkeys.map(([, , sub]) => sub) })
      }
      if (method === 'GET' && path === '/files/') {
        return Response.json(FileListing.parse({ files: [...egress.files].map(([p, f]) => ({ path: p, bytes: f.body.length })) }))
      }
      if (path.startsWith('/files/')) {
        const name = path.slice('/files/'.length).split('/').map(decodeURIComponent).join('/')
        if (method === 'GET') {
          const f = egress.files.get(name)
          return f ? new Response(f.body) : new Response('{"error":"no such file"}', { status: 404 })
        }
        if (method === 'PUT') {
          const body = init.body instanceof Uint8Array ? init.body : new TextEncoder().encode(String(init.body))
          egress.files.set(name, { body: new Uint8Array(body), contentType: init.headers?.['content-type'] })
          return Response.json({ ok: true })
        }
      }
      return new Response('{"error":"no such route"}', { status: 404 })
    },
  }
  return egress
}
