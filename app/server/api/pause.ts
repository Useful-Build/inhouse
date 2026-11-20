// Pause and resume (P3, p3-design sections 3 and 4.11): routes 35 to 37. Owner: W1 (p3-w1.md). An Admin or, for an
// emergency, the Inhouse team (item 19) pauses: every live turn is fenced, every queued one cancelled, nothing new is
// admitted; resume starts nothing. Each pause and resume writes its audit line, with whoever did it as the actor.
import { z } from 'zod'
import { apiError, apiJson } from '../http.ts'
import { readBody, storesOf, writer } from '../db/handler-kit.ts'
import { brandAgent } from '../do/brand-agent/client.ts'
import type { Actor } from '../do/brand-agent/ports.ts'
import type { Handler, HandlerContext } from '../routes.ts'

const NoBody = z.object({}).strict()

const actor = (c: HandlerContext): Actor | null =>
  c.principal.kind === 'person' || c.principal.kind === 'inhouse' ? { kind: c.principal.kind, memberId: c.principal.memberId } : null

/** Route 35, `GET /api/pause`. */
export const getPause: Handler = async c => apiJson(await brandAgent(c.env).getPause())

function change(to: 'pause' | 'resume'): Handler {
  return async (c: HandlerContext) => {
    const by = actor(c)
    if (!by) return apiError('forbidden')
    const body = await readBody(c.request, NoBody)
    if ('error' in body) return body.error
    const agent = brandAgent(c.env)
    const state = to === 'pause' ? await agent.pause(by) : await agent.resume(by)
    // The line follows the change: a failed write answers 5xx with the change made (a retry changes nothing more and
    // writes the line).
    await storesOf(c).chats.recordAgentLine(to === 'pause' ? 'agent.paused' : 'agent.resumed', writer(c))
    return apiJson(state)
  }
}

/** Route 36, `POST /api/pause` (Admin, or Inhouse for an emergency). */
export const pauseAgent: Handler = change('pause')
/** Route 37, `POST /api/resume`. */
export const resumeAgent: Handler = change('resume')
