// Paging (p2-design.md section 5): the request's `?limit=` and `cursor`, and one page of a list (the items and the
// opaque cursor of the next page, or null on the last). W2 owns this file in P2.
import { z } from 'zod'

/** An opaque keyset cursor: base64url of the last key, no padding, bounded so a query can't carry a large blob. */
export const CursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/)

/** A list request's query. `limit` arrives as query text, so it's coerced; 1 to 100, default 50. */
export const PageRequestSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: CursorSchema.optional(),
}).strict()
export type PageRequest = z.infer<typeof PageRequestSchema>

export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: CursorSchema.nullable() })
export type Page<T> = { items: T[]; nextCursor: string | null }
