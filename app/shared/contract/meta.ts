// Who the brand, the agent and the signed-in person are.
import './jitless.ts'
import { z } from 'zod'

export const AgentMetaSchema = z.object({
  brand: z.object({ name: z.string(), staff: z.number(), sells: z.string(), emailDomain: z.string() }),
  agent: z.object({ tone: z.string(), signsEmailsAs: z.string() }),
  currentUser: z.object({ id: z.string(), name: z.string(), initials: z.string(), email: z.string(), title: z.string(), role: z.string() }),
})
export type AgentMeta = z.infer<typeof AgentMetaSchema>
