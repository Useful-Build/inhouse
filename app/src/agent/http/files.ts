// Chat files over HTTP (P3, p3-design section 8.5, route 41): the bytes of one file, as the server names them.
// Plain code, no zod (the entry's size budget, schemas.ts).
import type { Transport } from './transport'

/**
 * The file name in a `Content-Disposition` header (RFC 6266): the `filename*=UTF-8''...` form when it decodes, else the
 * quoted `filename="..."`, else null.
 */
export function nameFromDisposition(header: string | null): string | null {
  if (header === null) return null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try { return decodeURIComponent(star[1]!.trim()) } catch { /* a bad escape: try the plain form */ }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)
  return plain ? plain[1]!.replace(/\\(.)/g, '$1') : null
}

/** Route 41, `GET /api/files/:fileId`: the file and the name the server gave it (null when it gave none). Rejects with an `AgentError`. */
export async function downloadFile(http: Transport, fileId: string): Promise<{ blob: Blob; name: string | null }> {
  const { blob, disposition } = await http.download(`/api/files/${encodeURIComponent(fileId)}`)
  return { blob, name: nameFromDisposition(disposition) }
}
