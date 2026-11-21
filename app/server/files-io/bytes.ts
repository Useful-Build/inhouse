// One file's body, streamed into R2 with its checks (p3-design 8.5): its declared length (the cap, and the bytes must
// match it), its type from its first bytes (the shared sniffer, never the name or a header), on the allowed list, and
// its SHA-256 counted as it streams. Both the egress's PUT and route 39 use it.
//
// Peak memory is a bounded prefix (`SNIFF_PREFIX_BYTES`) plus a chunk or two, never the file. The bytes go to R2 through
// a `FixedLengthStream` of the declared length (R2's `put` takes a stream only when its length is known; the stream
// errors if too few or too many bytes go through it). The last chunk is held back until the body has ended and every
// check passed; any refusal aborts the stream instead, so R2 never commits a refused body.
import { sniffType } from '../../shared/files/sniff.ts'
import { typeAllowed } from './caps.ts'

/** How much of a body the sniffer sees when the body is longer. A body this size or smaller is sniffed whole. */
export const SNIFF_PREFIX_BYTES = 1_048_576

/** The types the sniffer gives a text body: a longer one is checked as text to its end as it streams. */
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json'])

export type FileRefusal = 'too_large' | 'length_required' | 'length_mismatch' | 'type_not_allowed' | 'hash'

/** Writes the body (a stream of known length) to R2 as this type. */
export type FilePut = (body: ReadableStream<Uint8Array>, contentType: string) => Promise<unknown>

export interface StreamedFile {
  contentType: string
  sha256: string
  bytes: number
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')

/** The prefix without a UTF-8 sequence its end cuts in two, so a text body isn't misread as binary at the cut. */
function utf8Whole(b: Uint8Array): Uint8Array {
  for (let i = b.length - 1; i >= 0 && i >= b.length - 4; i--) {
    const x = b[i]!
    if ((x & 0xc0) === 0x80) continue
    const need = x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : x >= 0xc0 ? 2 : 1
    return b.length - i < need ? b.subarray(0, i) : b
  }
  return b
}

/**
 * Streams a request's body to `put` with the checks above; `sha256` (hex) is the hash the sender claims, if any. Answers
 * the file as kept, a refusal (nothing committed in R2), or `failed` with the error `put` threw. The length must be
 * declared (browsers and the runner's fetch both send it).
 */
export async function streamFile(request: Request, name: string, o: { max: number; sha256?: string; put: FilePut }): Promise<StreamedFile | { refused: FileRefusal } | { failed: unknown }> {
  const declared = request.headers.get('content-length')
  if (declared === null || !/^\d{1,12}$/.test(declared)) return { refused: 'length_required' }
  const length = Number(declared)
  if (length > o.max) return { refused: 'too_large' }
  const reader = request.body?.getReader() ?? null
  const next = async (): Promise<Uint8Array | null> => {
    for (;;) {
      if (!reader) return null
      const r = await reader.read()
      if (r.done) return null
      if (r.value.byteLength > 0) return r.value
    }
  }
  const refuse = async (refused: FileRefusal) => {
    await reader?.cancel()
    return { refused }
  }

  // 1. The prefix, then the type from it (before anything is written).
  const prefixLength = Math.min(length, SNIFF_PREFIX_BYTES)
  const prefix = new Uint8Array(prefixLength)
  let read = 0
  let carry: Uint8Array | null = null
  while (read < prefixLength) {
    const c = await next()
    if (!c) return refuse('length_mismatch')
    const take = Math.min(c.byteLength, prefixLength - read)
    prefix.set(c.subarray(0, take), read)
    read += take
    if (take < c.byteLength) carry = c.subarray(take)
  }
  const whole = length === prefixLength
  let contentType = sniffType(whole ? prefix : utf8Whole(prefix), name)
  if (!typeAllowed(contentType)) return refuse('type_not_allowed')
  // JSON is JSON only when the whole body parses, which a longer body can't show without holding all of it.
  if (!whole && contentType === 'application/json') contentType = 'text/plain'
  // A longer text body stays text to its end: no NUL byte, valid UTF-8 (the sniffer's own rule, over every byte).
  const text = !whole && TEXT_TYPES.has(contentType) ? new TextDecoder('utf-8', { fatal: true }) : null
  const isText = (c: Uint8Array | null) => {
    if (!text) return true
    if (c?.includes(0)) return false
    try {
      text.decode(c ?? undefined, { stream: c !== null })
      return true
    } catch {
      return false
    }
  }

  // 2. The stream to R2, its hash beside it.
  // `crypto.DigestStream` (Workers docs); typed through the Workers class, as the DOM lib's `Crypto` in this build hides it.
  const digest = new (crypto as unknown as { DigestStream: typeof DigestStream }).DigestStream('SHA-256')
  const hashing = digest.getWriter()
  const fixed = new FixedLengthStream(length)
  const out = fixed.writable.getWriter()
  // Both writers error when a body is refused (that's the point): their `closed` promises and the digest then reject
  // unread.
  out.closed.catch(() => undefined)
  hashing.closed.catch(() => undefined)
  digest.digest.catch(() => undefined)
  const putDone: Promise<{ ok: true } | { ok: false; e: unknown }> = o.put(fixed.readable, contentType).then(
    () => ({ ok: true }),
    (e: unknown) => ({ ok: false, e }),
  )
  const stop = async (refused: FileRefusal | null) => {
    // Aborting the writer errors R2's read of the stream, so the put fails and keeps nothing. The writer is already
    // errored when the put failed first; its abort then has nothing left to do.
    await out.abort(new Error(refused ?? 'put_failed')).catch(() => undefined)
    await hashing.abort()
    const put = await putDone
    await reader?.cancel()
    if (refused) return { refused }
    return { failed: put.ok ? new Error('put ended before its body') : put.e }
  }
  const feed = async (c: Uint8Array) => {
    if (!isText(c)) return false
    await hashing.write(c)
    return true
  }
  // A chunk is written while the put still reads; a put that ended (failed, or done too early) or a refused write stops it.
  const send = (c: Uint8Array) => Promise.race([
    out.ready.then(() => out.write(c)).then(() => true, () => false),
    putDone.then(() => false),
  ])

  let held: Uint8Array | null = prefixLength > 0 ? prefix : null
  if (held && !(await feed(held))) return stop('type_not_allowed')
  for (;;) {
    const c = carry ?? (await next())
    carry = null
    if (!c) break
    if (read + c.byteLength > length) return stop('length_mismatch')
    if (!(await feed(c))) return stop('type_not_allowed')
    read += c.byteLength
    if (held && !(await send(held))) return stop(null)
    held = c
  }
  if (read !== length) return stop('length_mismatch')
  if (!isText(null)) return stop('type_not_allowed')
  await hashing.close()
  const sha256 = hex(await digest.digest)
  if (o.sha256 !== undefined && sha256 !== o.sha256) return stop('hash')
  if (held && !(await send(held))) return stop(null)
  // A close that fails means the put failed too: its error is the one to answer.
  await Promise.race([out.close().catch(() => undefined), putDone])
  const put = await putDone
  if (!put.ok) return { failed: put.e }
  return { contentType, sha256, bytes: length }
}

/** A chat file id: `f_` + 128 random bits, base64url (FileIdSchema). */
export function newFileId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return `f_${btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}
