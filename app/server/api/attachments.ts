// Chat files (P3, p3-design sections 3 and 8.5): routes 39 to 41. Owner: W3 (p3-w3.md). PR0's stubs, each answering
// 503 `not_built` until W3 replaces it here.
import { notBuilt } from './not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 39, `POST /api/chats/:id/attachments` (bytes, `X-File-Name`). W3. */
export const uploadAttachment: Handler = notBuilt
/** Route 40, `GET /api/chats/:id/files`. W3. */
export const listChatFiles: Handler = notBuilt
/** Route 41, `GET /api/files/:fileId`. W3. */
export const getFile: Handler = notBuilt
