// The `authority-sweep` due task (p3-design 4.10): reads members removed and grants ended since its cursor from D1 and
// applies what the object's sets lack, closes sockets whose lease ran out, seeds `grant-expiry` for live grants, and
// runs again in 5 minutes (or at the next lease end) while any socket or unfinished turn exists. The work is
// authority.ts's, through the BrandAgent (`AgentCore.authoritySweep`). Idempotent by task id.
import type { TaskHandler } from '../scheduler.ts'

export const authoritySweep: TaskHandler = (_task, ctx) => ctx.agent.authoritySweep()
