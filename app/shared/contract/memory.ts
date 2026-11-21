// What the agent remembers, for the team and for the signed-in person.
import { z } from 'zod'
import { InstantSchema } from './common.ts'

/**
 * A remembered line and where it came from: `source` ("Sam told your Inhouse agent in a chat"), `at` when, `used` how
 * often ("used 7 times") and `lastUsed` when last. Shown as "Sam told your Inhouse agent in a chat, Nov 4 · used 7 times".
 */
export const MemoryLineSchema = z.object({
  key: z.string(),
  text: z.string(),
  source: z.string(),
  at: InstantSchema.optional(),
  used: z.string().optional(),
  lastUsed: InstantSchema.optional(),
  /** Revision of this line (forgetting it bumps it): a write sends it back as `ifRev`. */
  rev: z.number().int().min(1),
  /** P3 (W6): `brand` for a team line, `person` for the signed-in person's own. */
  scope: z.enum(['brand', 'person']).optional(),
  /** P3 (W6): true once forgotten (a write's answer, or a conflict's `current`); a list never holds a forgotten line. */
  forgotten: z.boolean().optional(),
})
export type MemoryLine = z.infer<typeof MemoryLineSchema>

export const MemoryDataSchema = z.object({
  team: z.array(z.object({ group: z.string(), lines: z.array(MemoryLineSchema) })),
  personal: z.array(MemoryLineSchema),
})
export type MemoryData = z.infer<typeof MemoryDataSchema>

// ---------- P3 (p3-design sections 3 and 10, W6): the routes' ids and bodies. ----------

/** A saved fact: `mem_` + 128 random bits, base64url (22 characters). A `MemoryLine`'s `key` is this id. */
export const MemoryIdSchema = z.string().regex(/^mem_[A-Za-z0-9_-]{22}$/)

/**
 * `PUT /api/memory/personal/:id/forgotten` and `PUT /api/memory/brand/:id/forgotten`: forget a line (`true`) or undo
 * that (`false`), at the rev last read. An undone team line waits for an admin's OK again; a person's counts at once.
 */
export const MemoryForgetInputSchema = z.object({ forgotten: z.boolean(), ifRev: z.number().int().min(1).max(999_999_999) }).strict()
