// Chat files over HTTP (P3, p3-design section 8.5, route 41): the bytes of one file, as the server names them.
// Plain code, no zod (the entry's size budget, schemas.ts).
import type { ChatFileItem } from '../../../shared/contract/attachments'
import { REASON } from '../../../shared/contract/error-codes'
import { AgentError } from '../types'
import type { Transport } from './transport'

export { UploadCancelled } from './transport'

/** Route 39's name header: `FILE_NAME_HEADER` in shared/contract/attachments.ts, which can't be imported here (it pulls zod into the entry; the upload test pins the value). */
const FILE_NAME_HEADER = 'X-File-Name'

/** An upload may take longer than a JSON call: a 20 MB file on a slow line. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000

/**
 * The file name in a `Content-Disposition` header (RFC 6266): the `filename*=UTF-8''...` form when it decodes, else the
 * quoted `filename="..."`, else null.
 */
export function nameFromDisposition(header: string | null): string | null {
  if (header === null) return null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star) {
    try { return cleanName(decodeURIComponent(star[1]!.trim())) } catch { /* a bad escape: try the plain form */ }
  }
  const plain = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)
  return plain ? cleanName(plain[1]!.replace(/\\(.)/g, '$1')) : null
}

/** A name that is safe to save under: control characters, `/` and `\` become `_`, leading dots go, it is trimmed and capped at 200; null when nothing is left. */
export function cleanName(raw: string): string | null {
  const name = raw.replace(/[\p{Cc}/\\]/gu, '_').replace(/^\.+/, '').trim().slice(0, 200).trim()
  return name === '' ? null : name
}

/** Route 41, `GET /api/files/:fileId`: the file and the name the server gave it (null when it gave none). Rejects with an `AgentError`. */
export async function downloadFile(http: Transport, fileId: string): Promise<{ blob: Blob; name: string | null }> {
  const { blob, disposition } = await http.download(`/api/files/${encodeURIComponent(fileId)}`)
  return { blob, name: nameFromDisposition(disposition) }
}

/**
 * Route 39, `POST /api/chats/:id/attachments`: the file as the server kept it (its id is what a message names). The body is
 * the `File` itself, so the browser streams it and declares its length. Rejects with an `AgentError` (a refusal has its
 * `reason`) or `UploadCancelled`.
 */
export const uploadFile = (http: Transport, chatId: string, file: File, signal?: AbortSignal): Promise<ChatFileItem> =>
  http.call({
    method: 'POST', path: `/api/chats/${encodeURIComponent(chatId)}/attachments`, schema: 'chatFile',
    bytes: { data: file, type: 'application/octet-stream' }, headers: { [FILE_NAME_HEADER]: encodeURIComponent(file.name) },
    ...(signal ? { signal } : {}), timeoutMs: UPLOAD_TIMEOUT_MS,
  })

/** What a person is told when a file isn't taken. The server's reason when it says something they can act on, else the plain failure. */
export function uploadRefusalText(name: string, e: unknown): string {
  const reason = e instanceof AgentError && e.code === 'invalid' ? e.reason : undefined
  if (reason === REASON.tooLarge) return `${name} is over the 20 MB limit.`
  if (reason === REASON.typeNotAllowed) return `${name} isn't a type Inhouse can read. Use a PDF, an image, a spreadsheet, a document or plain text.`
  if (reason === REASON.badName) return `${name} has a name Inhouse can't keep. Rename it and try again.`
  return `Couldn't upload ${name}. Try again.`
}
