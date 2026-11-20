// A run's recorded steps (`getTrace`).
import './jitless.ts'
import { z } from 'zod'
import { DurationMsSchema, MoneySchema } from './common.ts'

export const TraceStepKindSchema = z.enum(['root', 'model', 'tool', 'agent', 'wait', 'handoff', 'approval', 'answer', 'fail'])
export type TraceStepKind = z.infer<typeof TraceStepKindSchema>

/** `startMs` and `endMs` are ms from the start of the run. */
export const TraceStepSchema = z.object({ label: z.string(), kind: TraceStepKindSchema, startMs: DurationMsSchema, endMs: DurationMsSchema, depth: z.number(), detail: z.string() })
export type TraceStep = z.infer<typeof TraceStepSchema>

/** `id` is whatever the agent calls the run: a recorded key or a run id in the mock, a run id in phase 2. */
export const TraceSchema = z.object({ id: z.string(), title: z.string(), durationMs: DurationMsSchema, cost: MoneySchema, tokens: z.string(), steps: z.array(TraceStepSchema) })
export type Trace = z.infer<typeof TraceSchema>
