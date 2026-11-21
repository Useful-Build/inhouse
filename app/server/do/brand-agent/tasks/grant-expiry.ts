// The `grant-expiry:<grantId>` due task (p3-design 4.10): at the grant's end, once D1 says it ended, the object ends it
// too (its sockets close `4403`). Scheduled by route 17 (`onGrantCreated`) and seeded for live grants by the
// authority sweep. The work is authority.ts's, through the BrandAgent (`AgentCore.grantExpiry`). Idempotent by task id.
import type { TaskHandler } from '../scheduler.ts'

export const grantExpiry: TaskHandler = (task, ctx) => ctx.agent.grantExpiry(task.id)
