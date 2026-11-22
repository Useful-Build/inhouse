// The store-data graded run's transcript reader: whether a case's canary reached the run's transcript in the eval
// deployment's R2, the remote twin of run.mjs's local reader (which scans the test build's local R2 under --persist-dir).
// No product route carries a tool's result (the eval build keeps tool inputs only, server/eval-trace/on.ts), so this reads
// the session store's objects through Cloudflare's documented R2 REST API, GET only:
//   - List Objects, GET /accounts/{account_id}/r2/buckets/{bucket_name}/objects?prefix=&per_page=&cursor=
//     https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/ (read 2026-11-22)
//   - Get Object, GET /accounts/{account_id}/r2/buckets/{bucket_name}/objects/{object_key} (slashes literal, every other
//     reserved character percent-encoded; the body is the object's bytes)
//     https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/get/ (read 2026-11-22)
// wrangler can't list objects (`wrangler r2 object` has get, put and delete only:
// https://developers.cloudflare.com/workers/wrangler/commands/r2/), and a transcript part's name is a time and a counter
// (runner/src/store/adapter.ts partId), so the keys are listed, never guessed.
// What it reads: every object under `sessions/<the slot's chat>/` (r2-keys.ts sessionKey: the main transcript and any
// subagent's). A routine slot has its own chat (server/routines/keys.ts slotChatId), so that prefix is exactly the case's run.
// Every listed key must match the session store's exact shape, or nothing is read. Rules:
//   - the account is CF_SANDBOX_ACCOUNT_ID and the bucket is EVAL_BUCKET (the eval deployment's, scripts/sandbox/names.mjs
//     evalNames().r2, pinned by a test); anything else is refused before any request;
//   - the token is CLOUDFLARE_API_TOKEN from the runner's environment (the one wrangler reads for the D1 door), sent only in
//     the Authorization header, and cut from every error ([secret]); it needs R2 read on the sandbox account;
//   - redirects are never followed (`redirect: 'manual'`: a 3xx is refused);
//   - every request and body read has a deadline (TRANSCRIPT_CAPS.timeoutMs, AbortSignal.timeout plus a bound on the read);
//   - hard caps on list pages, keys and bytes per object; a cap hit, a listed object that can't be read or an answer of
//     the wrong shape fails loud. Every failure leaves as a DoorRefusal with the token cut and no cause attached;
//   - `preflight()` is one LIST of one key, made before the graded run writes anything (remote.ts buildRemote), so a token
//     without R2 read stops the run before it spends;
//   - canarySeen answers how many objects the chat holds as well: none is "not exposed" here, and the caller decides whether
//     a run that called tools and left no transcript is a miss (remote.ts storeDataReader stops the run then).
import { DoorRefusal } from '../../targets/door.ts'

/** The eval deployment's R2 bucket: scripts/sandbox/names.mjs evalNames().r2 (a test pins the two equal). */
export const EVAL_BUCKET = 'inhouse-sbx-eval-files'
export const R2_API_BASE = 'https://api.cloudflare.com/client/v4'

/**
 * The reader's hard caps: list pages (per_page 1000), objects under the chat, bytes per object (a store append is at most
 * 16 MB), and the deadline of each request with its body read.
 */
export const TRANSCRIPT_CAPS = { pages: 5, keys: 2000, objectBytes: 16 * 1024 * 1024, timeoutMs: 30_000 }
const PER_PAGE = 1000

/** A routine slot's chat id: `rc_` + 22 base64url characters (server/routines/keys.ts slotChatId). */
const SLOT_CHAT = /^rc_[A-Za-z0-9_-]{22}$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/
const UUID = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'

/**
 * The exact key of a stored transcript part under one chat (server/db/r2-keys.ts sessionKey): the SDK's session (a UUID,
 * shared/protocol StoreKey), sha256 of its project key, `m` or `s/<encodeURIComponent(subpath)>`, and the part
 * (`^[0-9]{15}-[0-9]{6}$`, shared/protocol StoreAppend).
 */
export const transcriptKey = (chatId: string): RegExp =>
  new RegExp(`^sessions/${chatId}/${UUID}/[0-9a-f]{64}/(m|s/(?!\\.{1,2}/)[A-Za-z0-9%._~!*'()-]{1,1600})/[0-9]{15}-[0-9]{6}\\.json$`)

/** The content test, shared with run.mjs's local reader: the object's bytes, read as latin1, hold the canary. */
export function holdsCanary(bytes: Uint8Array, canary: string): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').includes(canary)
}

export interface TranscriptReader {
  /** One LIST of one key under `sessions/`: refuses a token without R2 read (401, 403) or a missing bucket (404). */
  preflight(): Promise<void>
  /** How many objects the slot's chat holds, and whether any holds the canary (false when there is none). */
  canarySeen(chatId: string, canary: string): Promise<{ objects: number; seen: boolean }>
}

export interface TranscriptOptions {
  /** The runner's environment: CF_SANDBOX_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. */
  env: Record<string, string | undefined>
  /** Must be EVAL_BUCKET. */
  bucket: string
  fetch?: typeof fetch
  caps?: Partial<typeof TRANSCRIPT_CAPS>
}

export function createTranscriptReader(o: TranscriptOptions): TranscriptReader {
  if (o.bucket !== EVAL_BUCKET) throw new DoorRefusal(`refusing: ${JSON.stringify(o.bucket)} is not the eval deployment's bucket (${EVAL_BUCKET})`)
  const account = o.env.CF_SANDBOX_ACCOUNT_ID
  if (!account || !ACCOUNT_ID.test(account)) throw new DoorRefusal('refusing: CF_SANDBOX_ACCOUNT_ID is not set to an account id, so the bucket is not known to be the sandbox account\'s')
  const token = o.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new DoorRefusal('refusing: CLOUDFLARE_API_TOKEN is not set (R2 read on the sandbox account), so the transcript can\'t be read')
  const caps = { ...TRANSCRIPT_CAPS, ...o.caps }
  const doFetch = o.fetch ?? fetch
  const base = `${R2_API_BASE}/accounts/${account}/r2/buckets/${EVAL_BUCKET}/objects`
  const scrub = (text: string) => text.replaceAll(token, '[secret]')
  const said = (e: unknown) => scrub(e instanceof Error ? e.message : String(e))
  /** Every way out of the reader: one DoorRefusal, the token cut, no cause (a cause could carry it). */
  const refusing = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (e) {
      throw new DoorRefusal(said(e))
    }
  }

  /** A deadline for one request with its body read: the fetch's signal, and a bound on each await whatever the signal does. */
  function deadline(what: string) {
    const signal = AbortSignal.timeout(caps.timeoutMs)
    const at = Date.now() + caps.timeoutMs
    const within = <T>(p: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DoorRefusal(`R2 ${what} timed out after ${caps.timeoutMs} ms`)), Math.max(0, at - Date.now())) })
      return Promise.race([p, late]).finally(() => clearTimeout(timer))
    }
    return { signal, within }
  }

  /** One GET with the token in Authorization only, never following a redirect, within its deadline. */
  async function get(url: string, what: string, d: ReturnType<typeof deadline>): Promise<Response> {
    try {
      return await d.within(doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: d.signal }))
    } catch (e) {
      if (e instanceof DoorRefusal) throw e
      throw new DoorRefusal(`R2 ${what} failed: ${said(e)}`)
    }
  }

  /** The body's bytes, refused past the cap or the deadline while reading. */
  async function bytesOf(res: Response, key: string, d: ReturnType<typeof deadline>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let total = 0
    const reader = res.body?.getReader()
    if (!reader) return new Uint8Array()
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>
      try {
        step = await d.within(reader.read())
      } catch (e) {
        void reader.cancel().catch(() => {})
        throw e
      }
      const { done, value } = step
      if (done) break
      total += value.byteLength
      if (total > caps.objectBytes) {
        void reader.cancel().catch(() => {})
        throw new DoorRefusal(`R2 object ${key} is over the ${caps.objectBytes}-byte cap`)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks)
  }

  /** One page of a LIST: the parsed body of a 200 with success, else a DoorRefusal naming the status (`refused` words a 401/403/404). */
  async function page(q: URLSearchParams, what: string, refused?: (status: number) => string | null) {
    const d = deadline(what)
    const res = await get(`${base}?${q}`, what, d)
    const text = scrub(await d.within(res.text()))
    let body: { success?: unknown; errors?: { code?: unknown }[]; result?: unknown; result_info?: { cursor?: unknown; is_truncated?: unknown } } | null = null
    try { body = JSON.parse(text) } catch { /* named below */ }
    if (res.status !== 200 || body?.success !== true) {
      const words = refused?.(res.status)
      const codes = (Array.isArray(body?.errors) ? body.errors : []).map(e => e?.code).filter(c => Number.isInteger(c))
      throw new DoorRefusal(`R2 ${what} answered ${res.status}${codes.length ? ` (error ${codes.join(', ')})` : ''}${words ? `: ${words}` : ''}`)
    }
    return body
  }

  /** Every key under the chat's prefix, each checked against the store's shape, within the caps. */
  async function list(chatId: string): Promise<{ key: string; size: number }[]> {
    const prefix = `sessions/${chatId}/`
    const shape = transcriptKey(chatId)
    const out: { key: string; size: number }[] = []
    let cursor: string | null = null
    for (let n = 0; ; n++) {
      if (n >= caps.pages) throw new DoorRefusal(`R2 list under ${prefix} has more than ${caps.pages} pages: refusing past the cap`)
      const body = await page(new URLSearchParams({ prefix, per_page: String(PER_PAGE), ...(cursor === null ? {} : { cursor }) }), 'list')
      if (!Array.isArray(body.result)) throw new DoorRefusal('R2 list answered no result array')
      for (const item of body.result as { key?: unknown; size?: unknown }[]) {
        if (typeof item?.key !== 'string' || !shape.test(item.key)) throw new DoorRefusal(`R2 list under ${prefix} holds ${JSON.stringify(item?.key)}, not a transcript key: refusing to read any`)
        if (!Number.isInteger(item.size) || (item.size as number) < 0) throw new DoorRefusal(`R2 list gave no size for ${item.key}`)
        if ((item.size as number) > caps.objectBytes) throw new DoorRefusal(`R2 object ${item.key} is over the ${caps.objectBytes}-byte cap`)
        out.push({ key: item.key, size: item.size as number })
        if (out.length > caps.keys) throw new DoorRefusal(`R2 list under ${prefix} has more than ${caps.keys} objects: refusing past the cap`)
      }
      const info = body.result_info
      if (info?.is_truncated !== true) return out
      if (typeof info.cursor !== 'string' || info.cursor === '') throw new DoorRefusal('R2 list is truncated with no cursor')
      cursor = info.cursor
    }
  }

  return {
    preflight: () => refusing(async () => {
      await page(new URLSearchParams({ prefix: 'sessions/', per_page: '1' }), 'preflight', status =>
        status === 401 || status === 403 ? 'CLOUDFLARE_API_TOKEN lacks Workers R2 Storage Read on the sandbox account, so the run\'s transcript can\'t be read: refusing before any write or case'
          : status === 404 ? `no bucket ${EVAL_BUCKET} in account ${account} (the eval deployment's R2)`
            : null)
    }),
    canarySeen: (chatId, canary) => refusing(async () => {
      if (!SLOT_CHAT.test(chatId)) throw new DoorRefusal(`refusing: ${JSON.stringify(chatId)} is not a routine slot's chat id`)
      const keys = await list(chatId)
      for (const { key } of keys) {
        // The key's slashes stay literal, every segment percent-encoded (the Get Object page's rule).
        const d = deadline('get')
        const res = await get(`${base}/${key.split('/').map(encodeURIComponent).join('/')}`, 'get', d)
        if (res.status !== 200) {
          void res.body?.cancel().catch(() => {})
          throw new DoorRefusal(`R2 object ${key} was listed but could not be read (${res.status})`)
        }
        if (holdsCanary(await bytesOf(res, key, d), canary)) return { objects: keys.length, seen: true }
      }
      return { objects: keys.length, seen: false }
    }),
  }
}
