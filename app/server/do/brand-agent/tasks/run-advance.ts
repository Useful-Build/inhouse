// The `run-advance:<runId>` due task (p3-design 1.3.4): a run's pending file confirms, then its next queued turn or its
// end (core.ts `AgentCore.advanceTask`). Idempotent: it starts nothing while a turn of the run is unfinished.
import type { TaskHandler } from '../scheduler.ts'

export const RUN_ADVANCE_PREFIX = 'run-advance:'

export const runAdvance: TaskHandler = (task, ctx) => ctx.agent.advanceTask(task.id.slice(RUN_ADVANCE_PREFIX.length))
