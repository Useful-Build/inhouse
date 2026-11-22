// A run's recorded steps (`getTrace`).
import { z } from 'zod'
import { DurationMsSchema, MoneySchema } from './common.ts'

export const TraceStepKindSchema = z.enum(['root', 'model', 'tool', 'agent', 'wait', 'handoff', 'approval', 'answer', 'fail'])
export type TraceStepKind = z.infer<typeof TraceStepKindSchema>

/**
 * The eval build's kept input of one tool call (p3-eval-observability rev 2, rec 5): its JSON text, `cut` when the trace's
 * 256 KB of inputs ran out on it (or none was kept: `input` is then empty). `denied`: a hook denied this call (rec 6, the
 * harness's WebFetch refusal). Only the eval build keeps one, and only the run's owner reads it.
 */
export const StepIoSchema = z.strictObject({ input: z.string(), cut: z.literal(true).optional(), denied: z.literal(true).optional() })
export type StepIo = z.infer<typeof StepIoSchema>

/**
 * `startMs` and `endMs` are ms from the start of the run. `costUpTo`: a model call still open, counted in the trace's cost
 * at its admitted worst case until it closes (so the cost is an upper bound while one is set). `io`: a `tool` step's
 * kept input (eval build, owner only).
 */
export const TraceStepSchema = z.object({
  label: z.string(), kind: TraceStepKindSchema, startMs: DurationMsSchema, endMs: DurationMsSchema, depth: z.number(), detail: z.string(),
  costUpTo: z.boolean().optional(), io: StepIoSchema.optional(),
})
export type TraceStep = z.infer<typeof TraceStepSchema>

/**
 * `id` is whatever the agent calls the run: a recorded key or a run id in the mock, a run id in phase 2. `promptVersions`
 * (P5, #337): the system prompt version each of its turns was sent, in order (3 the built prompt, 2 the static fallback,
 * null a turn with none recorded); absent when no turn recorded one. The eval runners read it to know which prompt ran.
 */
export const TraceSchema = z.object({
  id: z.string(), title: z.string(), durationMs: DurationMsSchema, cost: MoneySchema, tokens: z.string(), steps: z.array(TraceStepSchema),
  promptVersions: z.array(z.number().int().nullable()).optional(),
})
export type Trace = z.infer<typeof TraceSchema>
