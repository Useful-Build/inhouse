// One file's checks before it's kept (p3-design 8.5): its type from its bytes (the shared sniffer, never the name or a
// header), on the allowed list; its SHA-256. Both the egress's PUT and route 39 use it.
import { sniffType } from '../../shared/files/sniff.ts'
import { typeAllowed } from './caps.ts'

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')

export async function checkFile(bytes: Uint8Array<ArrayBuffer>, name: string): Promise<{ contentType: string; sha256: string } | { refused: 'type_not_allowed' }> {
  const contentType = sniffType(bytes, name)
  if (!typeAllowed(contentType)) return { refused: 'type_not_allowed' }
  return { contentType, sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) }
}

/** A chat file id: `f_` + 128 random bits, base64url (FileIdSchema). */
export function newFileId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  return `f_${btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

/**
 * A file's body in one buffer of its declared length (route 39 and the egress's PUT): peak memory is the body's size,
 * not twice it (no chunk list then a copy). The length must be declared (browsers and the runner's fetch both send it)
 * and match the bytes. Full streaming to R2 (FixedLengthStream with a DigestStream) is a tracked follow-up (P3 "Later").
 */
export async function readFileBody(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | { refused: 'too_large' | 'length_required' | 'length_mismatch' }> {
  const declared = request.headers.get('content-length')
  if (declared === null || !/^\d{1,12}$/.test(declared)) return { refused: 'length_required' }
  const length = Number(declared)
  if (length > max) return { refused: 'too_large' }
  const out = new Uint8Array(length)
  if (!request.body) return length === 0 ? out : { refused: 'length_mismatch' }
  const reader = request.body.getReader()
  let at = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (at + value.byteLength > length) {
      await reader.cancel()
      return { refused: 'length_mismatch' }
    }
    out.set(value, at)
    at += value.byteLength
  }
  return at === length ? out : { refused: 'length_mismatch' }
}
