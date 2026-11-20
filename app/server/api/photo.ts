// Routes 13 to 15 (p2-design section 3): a person's own photo, uploaded and removed, and any member's photo read
// through the Worker only (never a public bucket or a signed URL). The type comes from the bytes alone; a Content-Type
// that names another type is refused. The body is read with a byte cap: Content-Length first, then counted as it streams.
import { MemberIdSchema } from '../../shared/contract/members.ts'
import { PHOTO_RESPONSE_HEADERS, apiError, apiJson } from '../http.ts'
import { readCapped, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { MAX_PHOTO_BYTES, photoType } from '../db/photo-bytes.ts'

const photoUrl = (memberId: string) => `/api/members/${encodeURIComponent(memberId)}/photo`

/** Route 13, `PUT /api/photo` (the image bytes): `{ photoUrl, rev }` (the member row's rev after the write). 400 `too_large` past 1 MiB, `bad_type` unless PNG, JPEG or WebP. */
export async function putPhoto(c: ApiCtx): Promise<Response> {
  const at = writer(c)
  // The caller's own photo: the owner check before anything is read or written (never inside a try).
  c.access.requireObject({ ownerId: at.actorId })
  const bytes = await readCapped(c.request, MAX_PHOTO_BYTES)
  if (bytes === null) return apiError('invalid', { reason: 'too_large' })
  const type = photoType(bytes)
  const declared = c.request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()
  if (type === null || declared !== type) return apiError('invalid', { reason: 'bad_type' })
  const done = await storesOf(c).photos.set({ memberId: at.actorId, bytes, type }, at)
  // Another upload or a removal changed the photo first: nothing of this one was kept; the photo as it is now.
  if ('conflict' in done) return apiError('conflict', { current: { photoUrl: done.conflict.photoKey ? photoUrl(at.actorId) : null, rev: done.conflict.rev } })
  return apiJson({ photoUrl: photoUrl(at.actorId), rev: done.rev })
}

/** Route 14, `DELETE /api/photo`: `{ photoUrl: null, rev }` (also when there was none: nothing changes, nothing is logged); 409 on a lost race. */
export async function deletePhoto(c: ApiCtx): Promise<Response> {
  const at = writer(c)
  c.access.requireObject({ ownerId: at.actorId })
  const done = await storesOf(c).photos.remove(at.actorId, at)
  // Another upload or removal changed it first: the photo as it is now (as the upload's race answers).
  if ('conflict' in done) return apiError('conflict', { current: { photoUrl: done.conflict.photoKey ? photoUrl(at.actorId) : null, rev: done.conflict.rev } })
  return apiJson({ photoUrl: null, rev: done.rev })
}

/** Route 15, `GET /api/members/:id/photo`: the bytes with the type stored at upload, never sniffed, never run. */
export async function getMemberPhoto(c: ApiCtx): Promise<Response> {
  const id = MemberIdSchema.safeParse(c.params.id)
  if (!id.success) return apiError('not_found')
  const photo = await storesOf(c).photos.get(id.data)
  if (!photo) return apiError('not_found')
  return new Response(photo.body, {
    status: 200,
    headers: { 'Content-Type': photo.type, ...PHOTO_RESPONSE_HEADERS },
  })
}
