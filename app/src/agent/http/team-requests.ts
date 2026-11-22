// Requests to the Inhouse team over HTTP (routes 80 to 83, P6a W3). Plain request builders (no zod here: the entry's size
// budget) and the one mapping from the server's records to what the pages read: `AgentState.requestedTools`,
// `requestedSkills` and `teamRequests` all come from the brand's open requests, never kept apart.
import type { TeamRequest } from '../../../shared/contract/state'
import type { TeamRequestRecord, TeamRequestsList } from '../../../shared/contract/team-requests'
import type { Contract, Transport } from './transport'

const path = (id: string, what: string) => `/api/team-requests/${encodeURIComponent(id)}/${what}`

/** Route 80: the brand's open requests, newest first. */
export const readOpenRequests = (http: Transport): Promise<TeamRequestsList> => http.call({ method: 'GET', path: '/api/team-requests?status=open', schema: 'teamRequests' })

/** Route 81: a request. */
export const postTeamRequest = (http: Transport, k: Contract, body: { kind: TeamRequestRecord['kind']; subject?: string; text: string }): Promise<TeamRequestRecord> =>
  http.call({ method: 'POST', path: '/api/team-requests', schema: 'teamRequest', json: k.BODIES.teamRequestCreate.parse(body) })

/** Route 83: the requester takes theirs back, against its `rev`. */
export const putWithdrawn = (http: Transport, k: Contract, id: string, ifRev: number): Promise<TeamRequestRecord> =>
  http.call({ method: 'PUT', path: path(id, 'withdrawn'), schema: 'teamRequest', json: k.BODIES.teamRequestWithdraw.parse({ ifRev }) })

const LABEL: Record<TeamRequestRecord['kind'], [icon: string, label: string]> = {
  tool: ['add_link', 'New tool'],
  job: ['work', 'New job'],
  change: ['tune', 'Change something'],
  bug: ['bug_report', 'Report a bug'],
  feedback: ['campaign', 'Feedback'],
}

/** A request's title: the first 60 characters, cut at a word and never inside one. */
const titleOf = (text: string) => {
  if (text.length <= 60) return text
  const cut = text.slice(0, 57)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 20)).trimEnd()}…`
}

/** What the pages read from the open requests. `nameOf`: a member's name by id, or null. */
export function fromOpen(open: readonly TeamRequestRecord[], nameOf: (id: string) => string | null): { teamRequests: TeamRequest[]; requestedTools: Record<string, true>; requestedSkills: Record<string, true> } {
  const requestedTools: Record<string, true> = {}
  const requestedSkills: Record<string, true> = {}
  const teamRequests: TeamRequest[] = []
  for (const r of open) {
    if (r.status !== 'open') continue
    if (r.subject && r.kind === 'tool') requestedTools[r.subject] = true
    if (r.subject && r.kind === 'job') requestedSkills[r.subject] = true
    const [icon, label] = LABEL[r.kind]
    teamRequests.push({ icon, title: titleOf(r.text), sub: `${label} · sent by ${r.mine ? 'you' : nameOf(r.requestedBy) ?? 'a teammate'}`, at: r.at, status: 'Sent' })
  }
  return { teamRequests, requestedTools, requestedSkills }
}
