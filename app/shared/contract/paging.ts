// One page of a list (p2-design.md section 5): the items and the opaque cursor of the next page, or null on the last. W2 owns this file in P2.
import { z } from 'zod'

export const pageOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().min(1).nullable() })
export type Page<T> = { items: T[]; nextCursor: string | null }
