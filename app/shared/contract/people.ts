// The team, who approves what, and the limits on what the agent does by itself.
import { z } from 'zod'
import { MemberIdSchema, MemberRecordSchema } from './members.ts'
import { SupportGrantSchema } from './grants.ts'

/** Who approves a rule: a member, or `anyone` (anyone who approves). Approving is a job per rule, not a role. */
export const ApproverSchema = z.union([MemberIdSchema, z.literal('anyone')])
export type Approver = z.infer<typeof ApproverSchema>

export const ApprovalRuleSchema = z.object({
  what: z.string(),
  detail: z.string(),
  approver: ApproverSchema,
  /** The rule's setting (`a:<n>`) revision: a write sends it back as `ifRev`. */
  rev: z.number().int().min(0),
})
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>

export const PeopleDataSchema = z.object({
  members: z.array(MemberRecordSchema),
  approvalRules: z.array(ApprovalRuleSchema),
  /** The latest support grant (live, ended or expired), or null when there never was one (p2-design.md section 9). */
  supportGrant: SupportGrantSchema.nullable(),
  runLimits: z.object({
    jobsAgentMayFinish: z.array(z.object({ id: z.string(), name: z.string(), desc: z.string() })),
    /** What always waits for a person, whatever the stage: "Money", "Customers". */
    alwaysWaitsForAPerson: z.array(z.string()),
    dailyActionLimit: z.number(),
    largestRestockUnits: z.number(),
  }),
})
export type PeopleData = z.infer<typeof PeopleDataSchema>
