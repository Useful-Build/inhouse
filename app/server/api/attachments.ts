// Chat files (P3, p3-design sections 3 and 8.5): routes 39 to 41. W3.
// - 39 uploads an attachment to the caller's own chat (another person's is 404, before `requireObject`).
// - 40 lists a chat's current files: the owner's own chat, or any chat for Inhouse under a grant.
// - 41 downloads one: an output to any person on the brand (BD11, outputs are the team's), an input to its chat's owner
//   or Inhouse under a grant. Always as an attachment, `nosniff` (the site headers), `default-src 'none'; sandbox` and
//   `private, no-cache` (the photo route's values, which `keepPhotoHeaders` keeps), the stored type.
import { ChatFileItemSchema, FILE_NAME_HEADER } from '../../shared/contract/attachments.ts'
import type { ChatFileItem } from '../../shared/contract/attachments.ts'
import { ChatIdSchema, FileIdSchema } from '../../shared/contract/chat-ids.ts'
import { badFileName } from '../../shared/files/names.ts'
import { storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { downloadName, typeAllowed } from '../files-io/caps.ts'
import type { StoredFile } from '../files-io/store.ts'
import { PHOTO_RESPONSE_HEADERS, apiError, apiJson } from '../http.ts'
import type { Handler } from '../routes.ts'

const item = (f: StoredFile): ChatFileItem =>
  ChatFileItemSchema.parse({ fileId: f.id, kind: f.kind, path: f.path, name: f.name, bytes: f.bytes, contentType: f.contentType, atMs: f.createdAtMs })

/** The decoded `X-File-Name`, or null when it isn't one segment of 1 to 200 characters the files route can carry. */
function fileName(header: string | null): string | null {
  if (header === null) return null
  let name: string
  try {
    name = decodeURIComponent(header)
  } catch {
    return null
  }
  if (name.length < 1 || name.length > 200 || name.includes('/')) return null
  // As it will be stored: `inputs/<fileId>-<name>`, so the segment's 255-byte limit counts the id too.
  if (badFileName(name) || badFileName(`inputs/f_${'x'.repeat(22)}-${name}`)) return null
  return name
}

/** Route 39, `POST /api/chats/:id/attachments` (the bytes, `X-File-Name`): the attachment as kept. */
export const uploadAttachment: Handler = async c => {
  const a: ApiCtx = c
  const chatId = ChatIdSchema.safeParse(a.params.id)
  if (!chatId.success) return apiError('not_found')
  const at = writer(a)
  const stores = storesOf(a)
  // Prefilter by owner: another person's chat is 404, then the owner rule with the owner found (p3-design 3).
  const owner = await stores.files.chatOwner(chatId.data)
  if (owner === null || owner !== at.actorId) return apiError('not_found')
  a.access.requireObject({ ownerId: owner })
  const name = fileName(a.request.headers.get(FILE_NAME_HEADER))
  if (name === null) return apiError('invalid', { reason: 'bad_name' })
  const saved = await stores.files.saveInput({ chatId: chatId.data, name, request: a.request, createdBy: at.actorId, nowMs: a.nowMs })
  if ('refused' in saved) return apiError('invalid', { reason: saved.refused })
  return apiJson(item(saved), 201)
}

/** Route 40, `GET /api/chats/:id/files`: `{ items }`, attachments first. */
export const listChatFiles: Handler = async c => {
  const a: ApiCtx = c
  if (new URL(a.request.url).search !== '') return apiError('invalid')
  const chatId = ChatIdSchema.safeParse(a.params.id)
  if (!chatId.success) return apiError('not_found')
  const stores = storesOf(a)
  const owner = await stores.files.chatOwner(chatId.data)
  if (owner === null) return apiError('not_found')
  // A person sees only their own chat (another's is 404); Inhouse under a grant passes the owner rule.
  if (a.principal.kind === 'person' && owner !== a.principal.memberId) return apiError('not_found')
  a.access.requireObject({ ownerId: owner })
  return apiJson({ items: (await stores.files.listCurrent(chatId.data)).map(item) })
}

/** `attachment; filename*=UTF-8''<name>` (RFC 6266), with an ASCII fallback. */
const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`

/** Route 41, `GET /api/files/:fileId`: the bytes, as an attachment. */
export const getFile: Handler = async c => {
  const a: ApiCtx = c
  const id = FileIdSchema.safeParse(a.params.fileId)
  if (!id.success) return apiError('not_found')
  const stores = storesOf(a)
  const f = await stores.files.savedById(id.data)
  if (!f || !typeAllowed(f.contentType)) return apiError('not_found')
  // An input is its chat owner's (and Inhouse's under a grant); an output any person's on the brand (BD11).
  if (f.kind === 'input' && a.principal.kind === 'person' && f.ownerId !== a.principal.memberId) return apiError('not_found')
  if (a.principal.kind === 'service') return apiError('not_found')
  const body = await stores.files.readBytes(f)
  if (!body) return apiError('not_found')
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': f.contentType, 'Content-Length': String(f.bytes), 'Content-Disposition': disposition(downloadName(f.name, f.contentType)), ...PHOTO_RESPONSE_HEADERS },
  })
}
