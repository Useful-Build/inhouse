// The Library over HTTP (P4 W5, rows 62 to 66). Plain code, no zod (the entry's size budget, schemas.ts): the transport
// parses each answer and the write bodies are built with the contract's schema once it has loaded.
import type { LibraryFiles, LibraryPage } from '../../../shared/contract/files'
import type { LibraryFile, LibraryPlace } from '../types'
import type { Contract, Transport } from './transport'

/** The Library's places, in the screen's order: `LIBRARY_PLACES`'s ids and names (files.ts can't be imported here: zod). Approvals stays empty until P6. */
export const PLACES: LibraryPlace[] = [
  { id: 'chats', name: 'Chats', icon: 'chat_bubble' },
  { id: 'routines', name: 'Routines', icon: 'event_repeat' },
  { id: 'approvals', name: 'Approvals', icon: 'task_alt' },
  { id: 'uploads', name: 'Uploaded by the team', icon: 'upload_file' },
]

/** Files per page; the client reads every page (a brand's Library is hundreds of files, not millions). */
export const LIBRARY_PAGE = 100
/** Row 63's name header (`LIBRARY_FILE_NAME_HEADER`). */
const FILE_NAME_HEADER = 'X-File-Name'
/** An upload may take longer than a JSON call: a 20 MB file on a slow line. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000

/** Row 64: where a file downloads from (`libraryDownloadPath`), the same path an image card's `src` uses. */
export const libraryDownloadPath = (id: string): string => `/api/library/${encodeURIComponent(id)}/download`

/** Row 62: one page of live files, newest first (`cursor` is the previous page's `nextCursor`). */
export function readLibraryPage(http: Transport, cursor?: string): Promise<LibraryPage> {
  const q = new URLSearchParams({ limit: String(LIBRARY_PAGE) })
  if (cursor !== undefined) q.set('cursor', cursor)
  return http.call({ method: 'GET', path: `/api/library?${q}`, schema: 'libraryPage' })
}

/** Every live file, page by page. */
export async function readLibrary(http: Transport): Promise<LibraryFile[]> {
  const out: LibraryFile[] = []
  let cursor: string | undefined
  do {
    const page = await readLibraryPage(http, cursor)
    out.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor !== undefined)
  return out
}

/** Rows 65 and 66: delete or restore these files, each against the revision the client holds. */
export const postLibraryWrite = (http: Transport, k: Contract, to: 'delete' | 'restore', items: { id: string; ifRev: number }[]): Promise<LibraryFiles> =>
  http.call({ method: 'POST', path: `/api/library/${to}`, schema: 'libraryFiles', json: k.BODIES.libraryWrite.parse({ items }) })

/** Row 63: one file as the server kept it. The body is the `File` itself, so the browser streams it and declares its length. */
export const uploadLibraryFile = (http: Transport, file: File): Promise<LibraryFile> =>
  http.call({
    method: 'POST', path: '/api/library/uploads', schema: 'libraryFile',
    bytes: { data: file, type: 'application/octet-stream' }, headers: { [FILE_NAME_HEADER]: encodeURIComponent(file.name) }, timeoutMs: UPLOAD_TIMEOUT_MS,
  })
