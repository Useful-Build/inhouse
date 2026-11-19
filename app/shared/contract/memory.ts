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
})
export type MemoryLine = z.infer<typeof MemoryLineSchema>

export const MemoryDataSchema = z.object({
  team: z.array(z.object({ group: z.string(), lines: z.array(MemoryLineSchema) })),
  personal: z.array(MemoryLineSchema),
})
export type MemoryData = z.infer<typeof MemoryDataSchema>
