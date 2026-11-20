// The session store route (p3-design 8.5): `POST /store/append|load|list-subkeys`, scoped to the grant. The key's
// `sessionId` must be the grant's; the chat is always the grant's. R2 keys (r2-keys.ts `sessionKey`):
// `sessions/<chatId>/<sessionId>/<sha256(projectKey)>/<sub>/<part>.json`, `<sub>` = `m` (main transcript) or
// `s/<encodeURIComponent(subpath)>` (a subagent's), disjoint. A load pages R2's list 1,000 at a time, stops at 64 MB,
// and streams its answer (`entriesStream`).
import { StoreAppend, StoreListSubkeys, StoreLoad } from '../../shared/protocol/index.ts'
import type { StoreKey } from '../../shared/protocol/index.ts'
import { sessionKey, sessionPrefix } from '../db/r2-keys.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import type { EgressDeps } from './deps.ts'
import { jsonAnswer, parseJson, readCapped, sha256Hex } from './http.ts'

/**
 * A load's answer, `{"entries":[...]}`, streamed one stored part at a time: each part is the JSON array an append wrote
 * (its entries already parsed and checked then), so its inside is spliced in as it is, never parsed or re-serialised.
 * Memory holds one part (an append is at most 16 MB), not the whole transcript, so the 64 MB stop fits a 128 MB isolate.
 */
function entriesStream(d: EgressDeps, keys: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  let wrote = false
  return new ReadableStream<Uint8Array>({
    start: c => c.enqueue(enc.encode('{"entries":[')),
    pull: async c => {
      if (i === keys.length) {
        c.enqueue(enc.encode(']}'))
        c.close()
        return
      }
      const obj = await d.bucket.get(keys[i++]!)
      if (!obj) return
      const text = (await obj.text()).trim()
      if (!text.startsWith('[') || !text.endsWith(']')) {
        c.error(new Error('a stored part is not a JSON array'))
        return
      }
      const inner = text.slice(1, -1).trim()
      if (inner === '') return
      c.enqueue(enc.encode(wrote ? `,${inner}` : inner))
      wrote = true
    },
  })
}

/** The most a store request body may be (an append's batch). */
export const STORE_BODY_MAX_BYTES = 16 * 1024 * 1024
/** A load past this many bytes stops with 413 (the store-size policy's, flagged to the orchestrator). */
export const STORE_LOAD_MAX_BYTES = 64 * 1024 * 1024

const scope = () => jsonAnswer({ error: 'scope' }, 403)

/** `m`, or `s/<encoded subpath>`. */
const subOf = (key: StoreKey) => (key.subpath === undefined ? 'm' : `s/${encodeURIComponent(key.subpath)}`)

export async function storeRoute(request: Request, path: string, grant: RunGrant, d: EgressDeps): Promise<Response> {
  if (request.method !== 'POST') return jsonAnswer({ error: 'method' }, 405)
  const op = path.slice('/store/'.length)
  if (op !== 'append' && op !== 'load' && op !== 'list-subkeys') return jsonAnswer({ error: 'not_found' }, 404)
  const bytes = await readCapped(request, STORE_BODY_MAX_BYTES)
  if (bytes === null) return jsonAnswer({ error: 'too_large' }, 413)
  const raw = parseJson(bytes)

  if (op === 'append') {
    const body = StoreAppend.safeParse(raw)
    if (!body.success) return jsonAnswer({ error: 'invalid' }, 400)
    if (body.data.key.sessionId !== grant.sessionId) return scope()
    const project = await sha256Hex(body.data.key.projectKey)
    const key = sessionKey(grant.chatId, grant.sessionId, project, subOf(body.data.key), body.data.part)
    // One object per part: a batch sent again carries the same part, so it overwrites rather than adds a copy.
    await d.bucket.put(key, JSON.stringify(body.data.entries), { httpMetadata: { contentType: 'application/json' } })
    return jsonAnswer({})
  }

  if (op === 'load') {
    const body = StoreLoad.safeParse(raw)
    if (!body.success) return jsonAnswer({ error: 'invalid' }, 400)
    if (body.data.key.sessionId !== grant.sessionId) return scope()
    const project = await sha256Hex(body.data.key.projectKey)
    const prefix = `${sessionPrefix(grant.chatId, grant.sessionId, project)}${subOf(body.data.key)}/`
    const keys: string[] = []
    let total = 0
    let cursor: string | undefined
    do {
      const page = await d.bucket.list({ prefix, cursor, limit: 1000 })
      for (const o of page.objects) {
        // Only this sub's own parts (a deeper key can't exist under `m/`, and `s/<enc>/` has no `/` in `<enc>`).
        if (o.key.slice(prefix.length).includes('/')) continue
        total += o.size
        if (total > STORE_LOAD_MAX_BYTES) return jsonAnswer({ error: 'too_large' }, 413)
        keys.push(o.key)
      }
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor !== undefined)
    if (keys.length === 0) return jsonAnswer({ entries: null })
    keys.sort()
    return new Response(entriesStream(d, keys), { headers: { 'content-type': 'application/json' } })
  }

  const body = StoreListSubkeys.safeParse(raw)
  if (!body.success) return jsonAnswer({ error: 'invalid' }, 400)
  if (body.data.key.sessionId !== grant.sessionId) return scope()
  const project = await sha256Hex(body.data.key.projectKey)
  const prefix = `${sessionPrefix(grant.chatId, grant.sessionId, project)}s/`
  const subkeys = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await d.bucket.list({ prefix, cursor, delimiter: '/', limit: 1000 })
    for (const p of page.delimitedPrefixes) subkeys.add(decodeURIComponent(p.slice(prefix.length, -1)))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor !== undefined)
  return jsonAnswer({ subkeys: [...subkeys].sort() })
}
