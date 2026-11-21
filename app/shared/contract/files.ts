// The Library's routes (P4 W5, p4-w5 sections 3 and 4): rows 62 to 66. What a file is (`LibraryFile`) is in ./library.ts;
// this file holds the requests and responses around it.
import { z } from 'zod'
import { FileIdSchema } from './chat-ids.ts'
import { LibraryFileSchema } from './library.ts'
import type { LibraryPlace } from './library.ts'
import { PageRequestSchema, pageOf } from './paging.ts'

/** The Library's places, in the order the screen shows them (approvals stays empty until P6). */
export const LIBRARY_PLACES: readonly LibraryPlace[] = [
  { id: 'chats', name: 'Chats', icon: 'chat_bubble' },
  { id: 'routines', name: 'Routines', icon: 'event_repeat' },
  { id: 'approvals', name: 'Approvals', icon: 'task_alt' },
  { id: 'uploads', name: 'Uploaded by the team', icon: 'upload_file' },
]

/** Route 62, `GET /api/library?cursor&limit&deleted`: newest first, 50 a page; `deleted=1` lists the deleted files only. */
export const LibraryQuerySchema = PageRequestSchema.extend({ deleted: z.enum(['0', '1']).optional() }).strict()
export const LibraryPageSchema = pageOf(LibraryFileSchema)
export type LibraryPage = z.infer<typeof LibraryPageSchema>

/** Route 63, `POST /api/library/uploads`: the bytes, the name percent-encoded (UTF-8) in this header. */
export const LIBRARY_FILE_NAME_HEADER = 'X-File-Name'
/** Route 63: the bytes' SHA-256 (64 lowercase hex), optional; a mismatch refuses the upload. */
export const LIBRARY_SHA256_HEADER = 'x-inhouse-sha256'

/** Route 64, `GET /api/library/:id/download`: the only path a Library file's bytes take (an image card's `src` too). */
export const libraryDownloadPath = (id: string): string => `/api/library/${encodeURIComponent(id)}/download`

/** Routes 65 and 66, `POST /api/library/delete` and `/restore`: 1 to 100 files, each with its last `rev`, no id twice. */
export const LibraryWriteSchema = z.object({
  items: z.array(z.object({ id: FileIdSchema, ifRev: z.number().int().min(1) }).strict()).min(1).max(100)
    .refine(items => new Set(items.map(i => i.id)).size === items.length, { message: 'an id is listed twice' }),
}).strict()
export type LibraryWrite = z.infer<typeof LibraryWriteSchema>

/** Routes 65 and 66: the files as they are after the write. A `conflict` carries the same shape as its `current`. */
export const LibraryFilesSchema = z.object({ items: z.array(LibraryFileSchema) })
export type LibraryFiles = z.infer<typeof LibraryFilesSchema>
