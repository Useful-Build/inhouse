// The Inhouse team tools (agent-tools "Inhouse team", P6a W3): `team_request_create` and `team_request_list`, as the run's
// person. A routine's own run (`m_system`) has no person to ask for, so it gets a refusal it can read. Text is plain; the
// request goes to the same store as the Inhouse team window (routes 80 to 83).
import { z } from 'zod'
import { TeamRequestKindSchema } from '../../../../shared/contract/audit.ts'
import { REASON } from '../../../../shared/contract/error-codes.ts'
import { TEAM_REQUEST_OPEN_MAX, TEAM_REQUEST_SUBJECT_MAX, TEAM_REQUEST_TEXT_MAX, TeamRequestStatusSchema } from '../../../../shared/contract/team-requests.ts'
import { SYSTEM_MEMBER_ID } from '../../../db/ids.ts'
import { createRequest, listRequests } from '../../../team-requests/store.ts'
import type { TeamRequestRow } from '../../../team-requests/store.ts'
import { answer, refusal, tool } from '../../server/tool.ts'
import type { InhouseToolName, ToolHandler, ToolScope } from '../../server/tool.ts'

export const NEEDS_PERSON_TEXT = 'A request to the Inhouse team needs a person. Tell the person in the summary instead.'
export const LIMIT_TEXT = `The brand already has ${TEAM_REQUEST_OPEN_MAX} open requests to the Inhouse team, the most it can have. Tell the person, and let the team answer some first.`

const at = (scope: ToolScope) => ({ actorId: scope.memberId, requestId: scope.requestId, nowMs: scope.nowMs })

/** A request as the agent reads it. */
const view = (r: TeamRequestRow, memberId: string) => ({
  request_id: r.id, kind: r.kind, subject: r.subject, text: r.text, status: r.status,
  asked: new Date(r.created_at_ms).toISOString(), yours: r.requested_by === memberId,
})

export const handlers: Partial<Record<InhouseToolName, ToolHandler>> = {
  team_request_create: tool({
    input: z.object({
      kind: TeamRequestKindSchema.describe('"tool" (connect a new tool), "job" (a new job or skill), "change", "bug" or "feedback".'),
      subject: z.string().trim().min(1).max(TEAM_REQUEST_SUBJECT_MAX).optional().describe('What it is about, such as the tool or skill name. At most 64 characters.'),
      text: z.string().trim().min(1).max(TEAM_REQUEST_TEXT_MAX).describe('What you need and why, in plain words. At most 1000 characters.'),
    }).strict(),
    async call(a, scope, deps) {
      if (scope.memberId === SYSTEM_MEMBER_ID) return refusal('forbidden', NEEDS_PERSON_TEXT)
      const o = await createRequest(deps.db, { kind: a.kind, ...(a.subject ? { subject: a.subject } : {}), text: a.text }, at(scope))
      if ('refused' in o) return refusal(REASON.requestLimit, LIMIT_TEXT)
      const r = o.ok
      // The same person's open request on this subject already says something: it was not filed again. Say so, with its words.
      if (!o.created && r.text !== a.text) {
        return answer(`There is already an open request about this from this person, so nothing new was sent. Its words: "${r.text}". Tell the person it's with the Inhouse team, and that they can take it back before asking again. (request_id: ${r.id})`, { ...view(r, scope.memberId), created: false })
      }
      return answer(`Sent to the Inhouse team (request_id: ${r.id}). The people who run this agent read it. Tell the person it's sent.`, { ...view(r, scope.memberId), created: o.created })
    },
  }),

  team_request_list: tool({
    input: z.object({ status: TeamRequestStatusSchema.optional().describe('Only requests with this status: "open", "done", "declined" or "withdrawn".') }).strict(),
    async call(a, scope, deps) {
      if (scope.memberId === SYSTEM_MEMBER_ID) return refusal('forbidden', NEEDS_PERSON_TEXT)
      const rows = await listRequests(deps.db, a.status)
      const items = rows.map(r => view(r, scope.memberId))
      const open = rows.filter(r => r.status === 'open').length
      return answer(items.length === 0 ? 'No requests to the Inhouse team.' : `${items.length} request${items.length === 1 ? '' : 's'} to the Inhouse team (${open} open), newest first.`, { requests: items })
    },
  }),
}
