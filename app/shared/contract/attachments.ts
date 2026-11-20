// P3's contract for attachment refs and file refusals. Owners: W1's first PR writes `AttachmentRefSchema` and
// `FileRefusalReasonSchema`, W3 the rest (p3-w1-pr1.md, p3-w3.md; p3-design sections 2 and 8.5).
import { z } from 'zod'
import { FileRefusalReason } from '../protocol/index.ts'
import { FileIdSchema } from './chat-ids.ts'

/** A file the person attached to a message: an `input` of the chat (route 39 made it), named as uploaded. */
export const AttachmentRefSchema = z.object({ fileId: FileIdSchema, name: z.string().min(1).max(200) })
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>

/** Why the runner didn't save an output file: the protocol's own list, so the two never drift. */
export const FileRefusalReasonSchema = FileRefusalReason
export type FileRefusalReason = z.infer<typeof FileRefusalReasonSchema>
