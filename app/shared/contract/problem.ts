// A problem the agent found, and the fix it drafted.
import { z } from 'zod'
import { PairSchema } from './common.ts'

export const ProblemSourceSchema = z.object({ n: z.string(), logo: z.string().optional(), icon: z.string().optional(), name: z.string(), text: z.string() })
export type ProblemSource = z.infer<typeof ProblemSourceSchema>

export const DraftSchema = z.object({
  title: z.string(),
  lines: z.array(PairSchema),
  bodyLabel: z.string().optional(),
  body: z.string().optional(),
  money: z.boolean().optional(),
  customer: z.boolean().optional(),
  /** Reversible: Undo stays after approval, no 10 s hold. */
  rev: z.boolean().optional(),
  memory: z.string().optional(),
  cta: z.string(),
  approver: z.string().optional(),
  ask: z.string().optional(),
  runTitle: z.string().optional(),
  runLines: z.array(PairSchema).optional(),
  doneNote: z.string().optional(),
})
export type Draft = z.infer<typeof DraftSchema>

export const ProblemSchema = z.object({
  id: z.string(),
  sev: z.string(),
  area: z.string(),
  title: z.string(),
  sub: z.string(),
  logos: z.array(z.string()),
  cost: z.string(),
  costNote: z.string(),
  next: z.string(),
  review: z.string().optional(),
  /** Run: what Inhouse agent did by itself. Present means handled in Run. */
  done: z.string().optional(),
  doneText: z.string(),
  /** What waits for a person in Run. */
  wait: z.string().optional(),
  partial: z.boolean().optional(),
  partialShort: z.string().optional(),
  runDoneText: z.string().optional(),
  isDraft: z.boolean().optional(),
  /** Trace id of the run that drafted or handled this problem. Missing means no steps to show. */
  trace: z.string().optional(),
  found: z.array(PairSchema),
  sources: z.array(ProblemSourceSchema),
  draft: DraftSchema,
  /** When the agent made this problem's draft, as shown (Activity, Approvals). Never sort on it: use `draftedMin`. */
  draftedAt: z.string(),
  /** The same time as minutes since midnight: what Approvals sorts by. */
  draftedMin: z.number(),
})
export type Problem = z.infer<typeof ProblemSchema>
