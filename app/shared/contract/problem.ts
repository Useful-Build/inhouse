// A problem the agent found, and the fix it drafted.
import { z } from 'zod'
import { InstantSchema, MoneySchema, PairSchema, ProseSchema } from './common.ts'

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
  /** Run, a partial draft: what the agent already did ("…paused the variant at {at:time}…"). */
  doneNote: ProseSchema.optional(),
})
export type Draft = z.infer<typeof DraftSchema>

export const ProblemSchema = z.object({
  id: z.string(),
  sev: z.string(),
  area: z.string(),
  title: z.string(),
  sub: z.string(),
  logos: z.array(z.string()),
  /** The money at stake, shown on the card ("$1,190"). */
  cost: MoneySchema,
  costNote: z.string(),
  next: z.string(),
  review: z.string().optional(),
  /**
   * Run: what Inhouse agent did by itself ("Paused the variant at {at:time}. Customer emails wait in Approvals"). Present
   * means handled in Run. `times.at` is when it did it: what Activity lists it by.
   */
  done: ProseSchema.refine(p => Object.hasOwn(p.times, 'at'), { message: 'done needs times.at, when the agent did it' }).optional(),
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
  /** When the agent made this problem's draft (Activity, Approvals): what Approvals sorts by. */
  draftedAt: InstantSchema,
})
export type Problem = z.infer<typeof ProblemSchema>
