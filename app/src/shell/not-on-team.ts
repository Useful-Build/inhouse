// Whether the signed-in person isn't on this team: the Worker answered 403, not invited or removed. The client puts
// that on the first resource it reads (`meta`), with the reason, so one test tells the shell to show "You're not on this team".
import { REASON } from '../../shared/contract/error-codes'
import type { AgentData } from '../agent/types'

export const notOnTeam = (data: Pick<AgentData, 'resources'>): boolean => {
  const r = data.resources.meta
  return r.status === 'error' && r.error === 'forbidden' && (r.reason === REASON.notInvited || r.reason === REASON.removed)
}
