// The `turn-watch:<turnId>` due task (p3-design 1.3 and 4.11): the watchdog of one unfinished turn, every 60 s while
// it's `starting|live|ending`, with its per-state rules in core.ts (`AgentCore.watch`). Idempotent by task id: each
// run reads the turn as stored and acts only on what it finds.
import type { TaskHandler } from '../scheduler.ts'

export const TURN_WATCH_PREFIX = 'turn-watch:'

export const turnWatch: TaskHandler = (task, ctx) => ctx.agent.watch(task.id.slice(TURN_WATCH_PREFIX.length))
