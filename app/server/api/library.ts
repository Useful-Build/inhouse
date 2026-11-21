// The Library's routes (P4 W5, p4-w5 section 3): rows 62 to 66. All `brand_data`; the matrix and the request path decide
// who reaches a route (members and Admins; the Inhouse team under a live grant, except the upload). Every person check
// is on the object: each id resolves to a listed file first (server/files/store.ts), and anything else answers 404,
// never 403, so ids can't be probed; a batch with one such id changes nothing.
import { FileIdSchema } from '../../shared/contract/chat-ids.ts'
import { LIBRARY_FILE_NAME_HEADER, LIBRARY_SHA256_HEADER, LibraryFilesSchema, LibraryPageSchema, LibraryQuerySchema, LibraryWriteSchema } from '../../shared/contract/files.ts'
import type { LibraryFiles, LibraryWrite } from '../../shared/contract/files.ts'
import { decodeCursor, encodeCursor, readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { typeAllowed } from '../files-io/caps.ts'
import { attachmentDisposition, libraryDownloadName, uploadName } from '../files/names.ts'
import type { LibraryRow, WriteOutcome } from '../files/store.ts'
import { libraryFile, viewerOf } from '../files/view.ts'
import { FILE_RESPONSE_HEADERS, apiError, apiJson } from '../http.ts'

const KEY = /^(\d{1,16})\.(f_[A-Za-z0-9_-]{22})$/
const SHA256 = /^[0-9a-f]{64}$/
/** Never served with their own type, whatever a row says (defence in depth: P3's list has none of them). */
const NEVER_OWN_TYPE = new Set(['text/html', 'image/svg+xml', 'application/xhtml+xml'])

/** The type a download goes out as: the stored (sniffed) type when it's on P3's list, else `application/octet-stream`. */
export const servedType = (stored: string): string => (typeAllowed(stored) && !NEVER_OWN_TYPE.has(stored) ? stored : 'application/octet-stream')

async function view(c: ApiCtx, rows: readonly LibraryRow[]): Promise<LibraryFiles['items']> {
  const library = storesOf(c).library
  const viewer = viewerOf(c.principal)
  return Promise.all(rows.map(async r => libraryFile(r, viewer, await library.textPreview(r))))
}

/** Row 62, `GET /api/library?cursor&limit&deleted`: a page of listed files, newest first. */
export async function listLibrary(c: ApiCtx): Promise<Response> {
  const q = readQuery(c.request, LibraryQuerySchema)
  if ('error' in q) return q.error
  let before: { atMs: number; id: string } | null = null
  if (q.ok.cursor !== undefined) {
    const m = KEY.exec(decodeCursor(q.ok.cursor) ?? '')
    if (!m) return apiError('invalid')
    before = { atMs: Number(m[1]), id: m[2] }
  }
  const { rows, last } = await storesOf(c).library.page({ deleted: q.ok.deleted === '1', limit: q.ok.limit, before })
  return apiJson(LibraryPageSchema.parse({ items: await view(c, rows), nextCursor: last === null ? null : encodeCursor(`${last.atMs}.${last.id}`) }))
}

/** Row 63, `POST /api/library/uploads` (the bytes, `X-File-Name`, optional `x-inhouse-sha256`): the file as kept, 201. */
export async function uploadLibraryFile(c: ApiCtx): Promise<Response> {
  const at = writer(c)
  const name = uploadName(c.request.headers.get(LIBRARY_FILE_NAME_HEADER))
  if (name === null) return apiError('invalid', { reason: 'bad_name' })
  const claimed = c.request.headers.get(LIBRARY_SHA256_HEADER)
  if (claimed !== null && !SHA256.test(claimed)) return apiError('invalid', { reason: 'hash' })
  const saved = await storesOf(c).library.upload({ name, request: c.request, sha256: claimed ?? undefined, at })
  if ('refused' in saved) return apiError('invalid', { reason: saved.refused })
  const [file] = await view(c, [saved.ok])
  return apiJson(file, 201)
}

/**
 * Row 64, `GET /api/library/:id/download`: the bytes, always as an attachment, `nosniff` (also the site headers),
 * `default-src 'none'; sandbox` and `private, no-store` (`FILE_RESPONSE_HEADERS`, as route 41; `keepPhotoHeaders` keeps
 * them through the API's wrap), the stored type or `application/octet-stream`. A deleted file is 404.
 */
export async function downloadLibraryFile(c: ApiCtx): Promise<Response> {
  const id = FileIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const library = storesOf(c).library
  const row = await library.byId(id.data)
  if (!row || row.deleted_at_ms !== null) return apiError('not_found')
  const o = await library.readObject(row)
  if (!o) return apiError('not_found')
  return new Response(o.body, {
    status: 200,
    headers: {
      'Content-Type': servedType(row.content_type),
      'Content-Length': String(o.size),
      'Content-Disposition': attachmentDisposition(libraryDownloadName(row.name, row.content_type)),
      'X-Content-Type-Options': 'nosniff',
      ...FILE_RESPONSE_HEADERS,
    },
  })
}

async function answer(c: ApiCtx, out: WriteOutcome): Promise<Response> {
  if ('not_found' in out) return apiError('not_found')
  if ('conflict' in out) return apiError('conflict', { current: LibraryFilesSchema.parse({ items: await view(c, out.conflict) }) })
  return apiJson(LibraryFilesSchema.parse({ items: await view(c, out.ok) }))
}

const write = (to: 'delete' | 'restore') => async (c: ApiCtx): Promise<Response> => {
  const body = await readBody(c.request, LibraryWriteSchema)
  if ('error' in body) return body.error
  const items: LibraryWrite['items'] = body.ok.items
  const library = storesOf(c).library
  return answer(c, await library[to](items, writer(c)))
}

/** Row 65, `POST /api/library/delete` `{ items: [{ id, ifRev }] }`: a soft delete (a mark) of 1 to 100 listed files. */
export const deleteLibraryFiles = write('delete')
/** Row 66, `POST /api/library/restore` `{ items: [{ id, ifRev }] }`: undo a delete. */
export const restoreLibraryFiles = write('restore')
