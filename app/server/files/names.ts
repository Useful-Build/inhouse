// A Library file's name on the way in and out (p4-w5 section 3, Sonnet L-8).
// In: the `X-File-Name` header is percent-encoded UTF-8; the stored name drops control, bidi and path characters and is
// 1 to 200 characters (code points, as SQLite's `length` counts them).
// Out: `Content-Disposition: attachment` with an ASCII `filename=` fallback (no `"`, `\`, CR, LF or control
// character; `%` becomes `_`) and the full name as `filename*=UTF-8''...` (RFC 6266 and RFC 5987), always under an extension of the
// stored type (P3's `downloadName`), so a text body named `page.html` never lands on a disk as `page.html`.
import { downloadName, typeAllowed } from '../files-io/caps.ts'

/** NUL, C0, DEL and C1 controls; the bidi marks, embeddings, overrides and isolates; and both slashes. */
// oxlint-disable-next-line no-control-regex -- control characters are what it drops
const DROPPED = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]/gu
export const NAME_MAX = 200

/** The name to store, or null when the header is missing, isn't percent-encoded UTF-8, or leaves no name. */
export function uploadName(header: string | null): string | null {
  if (header === null) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(header)
  } catch {
    return null
  }
  const name = decoded.replace(DROPPED, '').trim()
  const length = [...name].length
  return length >= 1 && length <= NAME_MAX ? name : null
}

/** The name a file downloads under: P3's rule for an allowed type; anything else ends in `.bin`. */
export function libraryDownloadName(name: string, contentType: string): string {
  if (typeAllowed(contentType)) return downloadName(name, contentType)
  return /\.bin$/i.test(name) ? name : `${name}.bin`
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<percent-encoded>`. Never `inline`. */
export function attachmentDisposition(name: string): string {
  // `%` too: some browsers percent-decode `filename=` and some don't.
  // oxlint-disable-next-line no-control-regex -- control characters are what it drops
  const ascii = name.replace(/[\u0000-\u001f\u007f"\\]/g, '').replace(/[^\x20-\x7e]|%/gu, '_').trim() || 'download'
  const encoded = encodeURIComponent(name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
