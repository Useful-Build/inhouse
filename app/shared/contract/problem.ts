// A problem the agent found, and the fix it drafted.
import { z } from 'zod'
import { InstantSchema, MoneySchema, PairSchema, ProseSchema } from './common.ts'

export const ProblemSourceSchema = z.object({ n: z.string(), logo: z.string().optional(), icon: z.string().optional(), name: z.string(), text: z.string() })
export type ProblemSource = z.infer<typeof ProblemSourceSchema>

/** One line of a structured purchase order: the panel draws these as its item table. */
export const DraftItemSchema = z.object({ name: z.string(), qty: z.number().int().positive(), each: MoneySchema })
export type DraftItem = z.infer<typeof DraftItemSchema>

/**
 * One fact in the panel's facts strip ("Stock left · 9 days · 190 at 21 a day", source 1). `bad` marks the bad news.
 * `shortLabel` and `shortNote` are what a phone shows, where three columns are narrow ("Delivery", "6 past orders").
 */
export const ProblemFactSchema = z.object({
  label: z.string(), value: z.string(), note: z.string(), source: z.string().optional(), tone: z.enum(['bad']).optional(),
  shortLabel: z.string().optional(), shortNote: z.string().optional(),
})
export type ProblemFact = z.infer<typeof ProblemFactSchema>

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
  /** What the draft is ("Purchase order", "Email", "Amazon case"). Missing: "Email" when it has a body, else "Draft". */
  kind: z.string().optional(),
  /** One sentence for the Today card's draft sheet. Missing: the first line as "key: value". */
  summary: z.string().optional(),
  /** The money approving it moves, and which way: a spend goes out, a claim asks for money back. */
  amount: z.object({ money: MoneySchema, direction: z.enum(['spend', 'claim']) }).optional(),
  /** A short name for where it goes, for the panel's progress line ("Kestrel", "5 customers"). Missing: "Sent". */
  destination: z.string().optional(),
  /** Who the document goes to, for the panel's From and To ("Kestrel Supply", "Mei Chen, as a PDF"). */
  to: z.object({ name: z.string(), note: z.string().optional() }).optional(),
  /** A purchase order's lines. Missing: the panel shows `lines` as key and value rows. */
  items: z.array(DraftItemSchema).min(1).optional(),
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
  /** Up to three facts for the panel's facts strip. Missing: the panel shows the "What your Inhouse agent found" card. */
  facts: z.array(ProblemFactSchema).min(1).max(3).optional(),
  draft: DraftSchema,
  /** When the agent made this problem's draft (Activity, Approvals): what Approvals sorts by. */
  draftedAt: InstantSchema,
})
export type Problem = z.infer<typeof ProblemSchema>
