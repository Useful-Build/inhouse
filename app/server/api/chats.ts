// Chats (P3, p3-design sections 3 and 4.7): routes 22 to 28 and 49. Owner: W1 (p3-w1.md). PR0's stubs, each answering
// 503 `not_built` until W1 replaces it here.
import { notBuilt } from './not-built.ts'
import type { Handler } from '../routes.ts'

/** Route 22, `GET /api/chats`. W1. */
export const listChats: Handler = notBuilt
/** Route 23, `POST /api/chats`. W1. */
export const createChat: Handler = notBuilt
/** Route 24, `GET /api/chats/:id`. W1. */
export const getChat: Handler = notBuilt
/** Route 25, `PUT /api/chats/:id/title`. W1. */
export const renameChat: Handler = notBuilt
/** Route 26, `PUT /api/chats/:id/pin`. W1. */
export const pinChat: Handler = notBuilt
/** Route 27, `POST /api/chats/delete`. W1. */
export const deleteChats: Handler = notBuilt
/** Route 28, `POST /api/chats/restore`. W1. */
export const restoreChats: Handler = notBuilt
/** Route 49, `POST /api/chats/:id/session/reset`. W1. */
export const resetSession: Handler = notBuilt
