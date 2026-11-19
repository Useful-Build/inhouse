// A run's recorded steps (`getTrace`).
import { z } from 'zod'

export const TraceStepKindSchema = z.enum(['root', 'model', 'tool', 'agent', 'wait', 'handoff', 'approval', 'answer', 'fail'])
export type TraceStepKind = z.infer<typeof TraceStepKindSchema>

export const TraceStepSchema = z.object({ label: z.string(), kind: TraceStepKindSchema, start: z.number(), end: z.number(), depth: z.number(), detail: z.string() })
export type TraceStep = z.infer<typeof TraceStepSchema>

/** `id` is whatever the agent calls the run: a recorded key or a run id in the mock, a run id in phase 2. */
export const TraceSchema = z.object({ id: z.string(), title: z.string(), duration: z.number(), cost: z.string(), tokens: z.string(), steps: z.array(TraceStepSchema) })
export type Trace = z.infer<typeof TraceSchema>
