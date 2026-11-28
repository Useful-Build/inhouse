// The read-side run's transcript reader: every stored part under `sessions/<the case's chat>/` in the deployment's R2, through
// Cloudflare's documented R2 REST API, GET only (the same API and rules as the store-data reader,
// exfiltration/store-data/transcripts.ts, which takes routine slot chats only and returns only whether the canary is there):
//   - List Objects https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/list/
//   - Get Object https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/get/
//   (both read 2026-11-22).
// Rules: the account is CF_SANDBOX_ACCOUNT_ID; the bucket is EVAL_BUCKET, or in the scripted proof only, that PR's own
// `inhouse-sbx-pr<N>-files`; the token is CLOUDFLARE_API_TOKEN, sent only in Authorization and cut from every error; redirects
// are refused; each request and body read has a deadline; list pages, keys and bytes are capped; every listed key must be the
// session store's exact shape (transcriptKey) under a chat id of the eval chats' shape, or nothing is read.
import { DoorRefusal } from '../../targets/door.ts'
import { TransientDoorError, withRetries, type RetryOptions } from '../../targets/retry.ts'
import { EVAL_BUCKET, R2_API_BASE, TRANSCRIPT_CAPS, transcriptKey } from '../../exfiltration/store-data/transcripts.ts'

/** The chats the product target makes: `eval-` and 24 hex (targets/product.ts rid). */
export const EVAL_CHAT = /^eval-[0-9a-f]{24}$/
const ACCOUNT_ID = /^[0-9a-f]{32}$/
const PER_PAGE = 1000

export interface SessionReader {
  /** One LIST of one key under `sessions/`: refuses a token without R2 read or a missing bucket, before any spend. */
  preflight(): Promise<void>
  /** Every stored part under the chat, in key order (part ids sort in append order). */
  parts(chatId: string): Promise<Uint8Array[]>
}

export interface SessionReaderOptions {
  env: Record<string, string | undefined>
  /** EVAL_BUCKET; or, with `proofPr`, exactly `inhouse-sbx-pr<proofPr>-files`. */
  bucket: string
  proofPr?: number
  fetch?: typeof fetch
  caps?: Partial<typeof TRANSCRIPT_CAPS>
  /** Each GET's retries on a transient failure (#691): where each is reported, the backoff (tests). */
  retry?: RetryOptions
}

/**
 * Why a failed R2 GET is clearly transient, as a fixed label, or null (#691): a network failure, a timeout, a 5xx or a 429.
 * A 4xx (no R2 read, no bucket), a cap or a bad answer is never transient: the run stops at once.
 */
export function r2Transient(e: unknown): string | null {
  if (e instanceof DoorRefusal) return /timed out after/.test(e.message) ? 'a timeout' : null
  if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'a timeout'
  if (e instanceof TypeError) return 'a network error' // undici's "fetch failed" (a reset, a refused connection, DNS)
  return null
}

export function createSessionReader(o: SessionReaderOptions): SessionReader {
  const allowed = o.proofPr === undefined ? EVAL_BUCKET : `inhouse-sbx-pr${o.proofPr}-files`
  if (o.proofPr !== undefined && !(Number.isInteger(o.proofPr) && o.proofPr >= 1 && o.proofPr <= 999_999)) throw new DoorRefusal('refusing: the proof PR number is not 1 to 999999')
  if (o.bucket !== allowed) throw new DoorRefusal(`refusing: ${JSON.stringify(o.bucket)} is not ${o.proofPr === undefined ? 'the eval deployment\'s bucket' : 'this PR\'s bucket'} (${allowed})`)
  const account = o.env.CF_SANDBOX_ACCOUNT_ID
  if (!account || !ACCOUNT_ID.test(account)) throw new DoorRefusal('refusing: CF_SANDBOX_ACCOUNT_ID is not set to an account id')
  const token = o.env.CLOUDFLARE_API_TOKEN
  if (!token) throw new DoorRefusal('refusing: CLOUDFLARE_API_TOKEN is not set (R2 read on the sandbox account)')
  const caps = { ...TRANSCRIPT_CAPS, ...o.caps }
  const doFetch = o.fetch ?? fetch
  const base = `${R2_API_BASE}/accounts/${account}/r2/buckets/${allowed}/objects`
  const scrub = (t: string) => t.replaceAll(token, '[secret]')
  const refusing = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (e) {
      throw new DoorRefusal(scrub(e instanceof Error ? e.message : String(e)))
    }
  }
  /**
   * One GET, retried on a transient failure (#691): a network error or a timeout while tries are left, and a 5xx or 429
   * answer (on the last try that answer is returned, so its caller names the status as before).
   */
  async function get(url: string, what: string): Promise<{ status: number; bytes: Uint8Array }> {
    return withRetries(`an R2 ${what.startsWith('object ') ? 'get' : what}`, async (last) => {
      let r: { status: number; bytes: Uint8Array }
      try {
        r = await getOnce(url, what)
      } catch (e) {
        const why = r2Transient(e)
        throw why ? new TransientDoorError(why, e instanceof Error ? e : new Error(String(e))) : e
      }
      if (!last && (r.status >= 500 || r.status === 429)) throw new TransientDoorError(r.status === 429 ? 'a 429 from R2' : 'a 5xx from R2', new DoorRefusal(`R2 ${what} answered ${r.status}`))
      return r
    }, o.retry)
  }
  /** One GET within the deadline, the body read whole and capped. */
  async function getOnce(url: string, what: string): Promise<{ status: number; bytes: Uint8Array }> {
    const signal = AbortSignal.timeout(caps.timeoutMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DoorRefusal(`R2 ${what} timed out after ${caps.timeoutMs} ms`)), caps.timeoutMs) })
    try {
      return await Promise.race([late, (async () => {
        const res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal })
        const chunks: Uint8Array[] = []
        let total = 0
        const reader = res.body?.getReader()
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > caps.objectBytes) {
              void reader.cancel().catch(() => {})
              throw new DoorRefusal(`R2 ${what} is over the ${caps.objectBytes}-byte cap`)
            }
            chunks.push(value)
          }
        }
        return { status: res.status, bytes: Buffer.concat(chunks) }
      })()])
    } finally {
      clearTimeout(timer)
    }
  }
  async function page(q: URLSearchParams, what: string) {
    const r = await get(`${base}?${q}`, what)
    let body: { success?: unknown; result?: unknown; result_info?: { cursor?: unknown; is_truncated?: unknown } } | null = null
    try { body = JSON.parse(new TextDecoder().decode(r.bytes)) } catch { /* named below */ }
    if (r.status !== 200 || body?.success !== true) {
      const words = r.status === 401 || r.status === 403 ? ': CLOUDFLARE_API_TOKEN lacks R2 read on the sandbox account' : r.status === 404 ? `: no bucket ${allowed}` : ''
      throw new DoorRefusal(`R2 ${what} answered ${r.status}${words}`)
    }
    return body
  }
  return {
    preflight: () => refusing(async () => {
      await page(new URLSearchParams({ prefix: 'sessions/', per_page: '1' }), 'preflight')
      // One real GET of a known object (the live smoke after #670): a token can list a bucket and still be refused its
      // objects. An earlier eval chat's first part is enough; with none in the bucket yet there is nothing to read.
      const first = await page(new URLSearchParams({ prefix: 'sessions/eval-', per_page: '1' }), 'preflight list')
      const item = Array.isArray(first.result) ? (first.result[0] as { key?: unknown; size?: unknown } | undefined) : undefined
      if (item === undefined) return
      const chat = typeof item.key === 'string' ? item.key.split('/')[1] ?? '' : ''
      if (typeof item.key !== 'string' || !EVAL_CHAT.test(chat) || !transcriptKey(chat).test(item.key)) throw new DoorRefusal(`R2 preflight list holds ${JSON.stringify(item.key)}, not a transcript key: refusing to read it`)
      if (!Number.isInteger(item.size) || (item.size as number) > caps.objectBytes) throw new DoorRefusal(`R2 object ${item.key} has no size or is over the cap`)
      const r = await get(`${base}/${item.key.split('/').map(encodeURIComponent).join('/')}`, 'preflight get')
      if (r.status !== 200) {
        const words = r.status === 401 || r.status === 403 ? ': CLOUDFLARE_API_TOKEN can list the bucket but not read its objects' : ''
        throw new DoorRefusal(`R2 preflight get answered ${r.status}${words}`)
      }
    }),
    parts: (chatId) => refusing(async () => {
      if (!EVAL_CHAT.test(chatId)) throw new DoorRefusal(`refusing: ${JSON.stringify(chatId)} is not an eval chat id`)
      const prefix = `sessions/${chatId}/`
      const shape = transcriptKey(chatId)
      const keys: string[] = []
      let cursor: string | null = null
      for (let n = 0; ; n++) {
        if (n >= caps.pages) throw new DoorRefusal(`R2 list under ${prefix} has more than ${caps.pages} pages`)
        const body = await page(new URLSearchParams({ prefix, per_page: String(PER_PAGE), ...(cursor === null ? {} : { cursor }) }), 'list')
        if (!Array.isArray(body.result)) throw new DoorRefusal('R2 list answered no result array')
        for (const item of body.result as { key?: unknown; size?: unknown }[]) {
          if (typeof item?.key !== 'string' || !shape.test(item.key)) throw new DoorRefusal(`R2 list under ${prefix} holds ${JSON.stringify(item?.key)}, not a transcript key: refusing to read any`)
          if (!Number.isInteger(item.size) || (item.size as number) > caps.objectBytes) throw new DoorRefusal(`R2 object ${item.key} has no size or is over the cap`)
          keys.push(item.key)
          if (keys.length > caps.keys) throw new DoorRefusal(`R2 list under ${prefix} has more than ${caps.keys} objects`)
        }
        if (body.result_info?.is_truncated !== true) break
        if (typeof body.result_info.cursor !== 'string' || body.result_info.cursor === '') throw new DoorRefusal('R2 list is truncated with no cursor')
        cursor = body.result_info.cursor
      }
      keys.sort()
      const parts: Uint8Array[] = []
      for (const key of keys) {
        const r = await get(`${base}/${key.split('/').map(encodeURIComponent).join('/')}`, `object ${key}`)
        if (r.status !== 200) throw new DoorRefusal(`R2 object ${key} was listed but could not be read (${r.status})`)
        parts.push(r.bytes)
      }
      return parts
    }),
  }
}
