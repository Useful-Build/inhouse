// The team, who approves what, and the limits on what the agent does by itself.
import { z } from 'zod'

export const PeopleDataSchema = z.object({
  members: z.array(z.object({ id: z.string(), name: z.string(), photo: z.string().optional(), email: z.string(), title: z.string(), role: z.string() })),
  approvalRules: z.array(z.object({ what: z.string(), detail: z.string(), approver: z.string() })),
  runLimits: z.object({
    jobsAgentMayFinish: z.array(z.object({ id: z.string(), name: z.string(), desc: z.string() })),
    /** What always waits for a person, whatever the stage: "Money", "Customers". */
    alwaysWaitsForAPerson: z.array(z.string()),
    dailyActionLimit: z.number(),
    largestRestockUnits: z.number(),
  }),
})
export type PeopleData = z.infer<typeof PeopleDataSchema>
