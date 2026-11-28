// Stage 1 M2 (N18): the agent's actions (routes 120 to 124; Stage 1 M3-U: 125 and 126), the permissions (110 and 111) and the questions (140 and
// 141) over HTTP. No zod here (the entry's size budget, schemas.ts): the transport parses each answer with the lazily
// loaded schemas, and a body is built from them by the caller's `Contract`.
import type { ActionAnswerTotals, ActionCard, ActionChoice, ActionFilter, ActionItemsPage, ActionResolution, ActionsList } from '../../../shared/contract/actions'
import type { Permission, PermissionsList } from '../../../shared/contract/permissions'
import type { Question, QuestionsList } from '../../../shared/contract/questions'
import type { Contract, Transport } from './transport'

const enc = encodeURIComponent

/** Route 120's query: `?states=a,b&chatId=`, or nothing. */
export function actionsQuery(filter: ActionFilter = {}): string {
  const q = new URLSearchParams()
  if (filter.states) q.set('states', filter.states.join(','))
  if (filter.chatId) q.set('chatId', filter.chatId)
  const text = q.toString()
  return text ? `?${text}` : ''
}

/** Route 120: the cards this person may see, newest first. */
export const readActions = (http: Transport, filter?: ActionFilter): Promise<ActionsList> =>
  http.call({ method: 'GET', path: `/api/actions${actionsQuery(filter)}`, schema: 'actions' })

/** Route 121: one card. */
export const readAction = (http: Transport, id: string): Promise<ActionCard> =>
  http.call({ method: 'GET', path: `/api/actions/${enc(id)}`, schema: 'actionCard' })

/**
 * Route 122: an answer to a waiting card, at the rev it was read at. A batch's (Stage 1 M3, N22) names the items it covers
 * and their totals as the card showed them.
 */
export const postAnswer = (http: Transport, k: Contract, id: string, ifRev: number, choice: ActionChoice, covers?: { upTo: number; totals: ActionAnswerTotals }): Promise<ActionCard> =>
  http.call({ method: 'POST', path: `/api/actions/${enc(id)}/answer`, schema: 'actionCard', json: k.BODIES.answerAction.parse({ choice, ifRev, ...(covers ? { upTo: covers.upTo, totals: covers.totals } : {}) }) })

/** Route 123: Undo during the hold. */
export const postUndo = (http: Transport, k: Contract, id: string, ifRev: number): Promise<ActionCard> =>
  http.call({ method: 'POST', path: `/api/actions/${enc(id)}/undo`, schema: 'actionCard', json: k.BODIES.undoAction.parse({ ifRev }) })

/** Route 124: whether a "Needs a check" action went out; a batch's one item at a time, by position (Stage 1 M3). */
export const postResolve = (http: Transport, k: Contract, id: string, ifRev: number, outcome: ActionResolution, item?: number): Promise<ActionCard> =>
  http.call({ method: 'POST', path: `/api/actions/${enc(id)}/resolve`, schema: 'actionCard', json: k.BODIES.resolveAction.parse({ outcome, ifRev, ...(item !== undefined ? { item } : {}) }) })

/** Route 125 (Stage 1 M3, N22): one page of a batch's items, after position `after`. */
export const readActionItems = (http: Transport, id: string, after: number): Promise<ActionItemsPage> =>
  http.call({ method: 'GET', path: `/api/actions/${enc(id)}/items?after=${after}`, schema: 'actionItems' })

/** Route 126 (Stage 1 M3, N25): the asker takes back their own waiting card. */
export const postWithdraw = (http: Transport, k: Contract, id: string, ifRev: number): Promise<ActionCard> =>
  http.call({ method: 'POST', path: `/api/actions/${enc(id)}/withdraw`, schema: 'actionCard', json: k.BODIES.withdrawAction.parse({ ifRev }) })

/** Route 110: this person's permissions (an admin's: everyone's). */
export const readPermissions = async (http: Transport): Promise<Permission[]> =>
  (await http.call({ method: 'GET', path: '/api/permissions', schema: 'permissions' }) satisfies PermissionsList).items

/** Route 111: removes one, at the rev it was read at; answers the list after it. */
export const postRemovePermission = async (http: Transport, k: Contract, id: string, ifRev: number): Promise<Permission[]> =>
  (await http.call({ method: 'POST', path: `/api/permissions/${enc(id)}/remove`, schema: 'permissions', json: k.BODIES.removePermission.parse({ ifRev }) }) satisfies PermissionsList).items

/** Route 140: the open questions asked of this person, oldest first. */
export const readQuestions = async (http: Transport): Promise<Question[]> =>
  (await http.call({ method: 'GET', path: '/api/questions', schema: 'questions' }) satisfies QuestionsList).items

/** Route 141: answers one with the option chosen. */
export const postQuestionAnswer = (http: Transport, k: Contract, id: string, choice: string): Promise<Question> =>
  http.call({ method: 'POST', path: `/api/questions/${enc(id)}/answer`, schema: 'question', json: k.BODIES.answerQuestion.parse({ choice }) })
