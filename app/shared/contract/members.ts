// A member of the team. W2 owns this file in P2.
import { z } from 'zod'

export const MemberSchema = z.object({ id: z.string(), name: z.string(), photo: z.string().optional(), email: z.string(), title: z.string(), role: z.string() })
export type Member = z.infer<typeof MemberSchema>
