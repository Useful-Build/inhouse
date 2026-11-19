// The Library: every file the agent made or the team shared.
import { z } from 'zod'
import { PairSchema } from './common.ts'

export const LibraryKindSchema = z.enum(['images', 'documents', 'code', 'media', 'other'])
export type LibraryKind = z.infer<typeof LibraryKindSchema>

export const LibraryPlaceSchema = z.object({ id: z.string(), name: z.string(), icon: z.string() })
export type LibraryPlace = z.infer<typeof LibraryPlaceSchema>

/** A first page for documents Inhouse agent made: a small structured document the Library draws, not a real PDF render. */
export const DocPreviewSchema = z.object({
  tag: z.string(),
  title: z.string(),
  meta: z.array(PairSchema),
  table: z.object({ head: z.array(z.string()), rows: z.array(z.array(z.string())), total: z.union([z.string(), z.array(z.string())]).optional() }).optional(),
  note: z.string().optional(),
})
export type DocPreview = z.infer<typeof DocPreviewSchema>

/** Where a file came from. Opening it goes to that chat, the Routines page or that approval. Uploads have no link. */
export const LibraryLinkSchema = z.union([
  z.object({ to: z.enum(['chat', 'approval']), id: z.string() }),
  z.object({ to: z.literal('routines') }),
])
export type LibraryLink = z.infer<typeof LibraryLinkSchema>

export const LibraryFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The badge: PDF, CSV, MD, XLSX, JSON, SQL, PY, PNG, JPG, M4A, MP4, ZIP, ICS. */
  type: z.string(),
  kind: LibraryKindSchema,
  /** A LibraryPlace id. */
  place: z.string(),
  /** Shown on the card: "Chat: Stuck orders over 3 days", "Routine: Morning check", "Uploaded by Priya Shah". */
  from: z.string(),
  link: LibraryLinkSchema.optional(),
  by: z.string(),
  /** True when the agent made the file, false when a person uploaded it. Decides "Made by" or "Uploaded by". */
  madeByAgent: z.boolean(),
  size: z.string(),
  /** Shown. It carries no year on purpose. */
  date: z.string(),
  /** Sort key, newest last when ascending. */
  at: z.string(),
  /** Images: the picture and its width/height ratio. */
  src: z.string().optional(),
  ratio: z.string().optional(),
  doc: DocPreviewSchema.optional(),
  table: z.object({ head: z.array(z.string()), rows: z.array(z.array(z.string())), total: z.string() }).optional(),
  /** Code and text files: the contents. */
  text: z.string().optional(),
  media: z.enum(['audio', 'video']).optional(),
  duration: z.string().optional(),
  poster: z.string().optional(),
  /** ZIP: what is inside. */
  entries: z.array(z.string()).optional(),
  /** Calendar files: the events. */
  lines: z.array(PairSchema).optional(),
})
export type LibraryFile = z.infer<typeof LibraryFileSchema>
