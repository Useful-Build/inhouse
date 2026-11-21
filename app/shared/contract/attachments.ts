// P3's contract for attachment refs and file refusals. Owners: W1's first PR writes `AttachmentRefSchema` and
// `FileRefusalReasonSchema`, W3 the rest (p3-w1-pr1.md, p3-w3.md; p3-design sections 2 and 8.5).
import { z } from 'zod'
import { FileRefusalReason } from '../protocol/index.ts'
import { FileIdSchema } from './chat-ids.ts'

/**
 * A file the person attached to a message: an `input` of the chat (route 39 made it), named as uploaded (no control
 * characters). Route 29 takes the stored name and path from the file's row, never this one.
 */
export const AttachmentRefSchema = z.object({ fileId: FileIdSchema, name: z.string().min(1).max(200).regex(/^\P{Cc}*$/u) })
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>

/** Why the runner didn't save an output file: the protocol's own list, so the two never drift. */
export const FileRefusalReasonSchema = FileRefusalReason
export type FileRefusalReason = z.infer<typeof FileRefusalReasonSchema>

// ---------- W3 (p3-design 3 and 8.5): routes 39 to 41 ----------

/** A chat file as routes 39 and 40 show it: an attachment (`input`) or a file a turn saved (`output`). */
export const ChatFileItemSchema = z.object({
  fileId: FileIdSchema,
  kind: z.enum(['input', 'output']),
  /** The file's path in the chat's work folder (`inputs/<fileId>-<name>` or `outputs/...`). */
  path: z.string().min(1).max(1024),
  name: z.string().min(1).max(1024),
  bytes: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(128),
  atMs: z.number().int().nonnegative(),
})
export type ChatFileItem = z.infer<typeof ChatFileItemSchema>

/** Route 39's answer: the attachment as kept, ready to send as an `AttachmentRef`. */
export const UploadResultSchema = ChatFileItemSchema
/** Route 40's answer: the chat's current files, attachments first, each newest first. */
export const ChatFilesSchema = z.object({ items: z.array(ChatFileItemSchema) })
export type ChatFiles = z.infer<typeof ChatFilesSchema>
/**
 * Route 39's `X-File-Name`: the file's name, `encodeURIComponent`-encoded (a header carries ASCII only). Decoded, it's
 * 1 to 200 characters, one segment (no `/`), and a name the runner's files route can carry.
 */
export const FILE_NAME_HEADER = 'X-File-Name'
