// Requests to the Inhouse team over HTTP (routes 80 to 83, P6a W3). Plain request builders (no zod here: the entry's size
// budget) and the one mapping from the server's records to what the pages read: `AgentState.requestedTools`,
// `requestedSkills` and `teamRequests` all come from the brand's open requests, never kept apart.
import type { Instant } from '../../../shared/contract/common'
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

/**
 * The words the server keeps for a request from the team window: the title on its own line above the details, or
 * either alone. A title the window made from the details (nothing typed in Title) isn't repeated.
 */
export const requestWords = (title: string, text: string | undefined): string => {
  const t = title.trim(), d = text?.trim() ?? ''
  return !d ? t : t === titleOf(d) ? d : `${t}\n\n${d}`
}

/** What the team window's row for a request is named by (`teamRequestKey`): when it was asked and its title. */
export const requestKey = (r: { at: Instant; text: string }): string => `${r.at.ms}|${titleOf(r.text.split('\n')[0])}`

const CLOSED_STATUS = { done: 'Done', declined: 'Declined', withdrawn: 'Withdrawn' } as const

/**
 * What the pages read from the requests. The brand's open ones are read (route 80); one answered or withdrawn in this session
 * stays as a closed row until the next read of the open ones, and never marks a tool or skill as requested.
 * `nameOf`: a member's name by id, or null.
 */
export function fromOpen(open: readonly TeamRequestRecord[], nameOf: (id: string) => string | null): { teamRequests: TeamRequest[]; requestedTools: Record<string, true>; requestedSkills: Record<string, true> } {
  const requestedTools: Record<string, true> = {}
  const requestedSkills: Record<string, true> = {}
  const teamRequests: TeamRequest[] = []
  for (const r of open) {
    const closed = r.status === 'open' ? undefined : r.status
    if (!closed && r.subject && r.kind === 'tool') requestedTools[r.subject] = true
    if (!closed && r.subject && r.kind === 'job') requestedSkills[r.subject] = true
    const [icon, label] = LABEL[r.kind]
    // The title is the first line (the team window's Title, when one was typed); the row opens to the words in full.
    teamRequests.push({
      icon, title: titleOf(r.text.split('\n')[0]), sub: `${label} · sent by ${r.mine ? 'you' : (r.requestedBy ? nameOf(r.requestedBy) : null) ?? 'a teammate'}`, at: r.at,
      status: closed ? CLOSED_STATUS[closed] : 'With the team', kind: r.kind, text: r.text, mine: r.mine, ...(closed ? { closed } : {}),
    })
  }
  return { teamRequests, requestedTools, requestedSkills }
}
