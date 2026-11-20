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
