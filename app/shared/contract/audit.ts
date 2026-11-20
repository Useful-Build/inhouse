// The audit log: changes to how the agent may work. W2 owns this file in P2 (its actions and the `AuditEntry` it becomes).
import { z } from 'zod'
import { InstantSchema } from './common.ts'

export const AuditEntrySchema = z.object({ at: InstantSchema, who: z.string(), what: z.string(), detail: z.string() })
export type AuditEntry = z.infer<typeof AuditEntrySchema>
