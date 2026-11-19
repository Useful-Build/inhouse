// What the agent remembers, for the team and for the signed-in person.
import { z } from 'zod'

export const MemoryLineSchema = z.object({ key: z.string(), text: z.string(), source: z.string() })
export type MemoryLine = z.infer<typeof MemoryLineSchema>

export const MemoryDataSchema = z.object({
  team: z.array(z.object({ group: z.string(), lines: z.array(MemoryLineSchema) })),
  personal: z.array(MemoryLineSchema),
})
export type MemoryData = z.infer<typeof MemoryDataSchema>
