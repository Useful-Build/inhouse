// What the product shows in place of the pages, from the first resource the client reads (`meta`), which carries the
// failure with its kind. Not on the team (a 403 not invited or removed) and signed out (a 401: the Access session ended)
// can't be fixed by asking again; any other failure is a load error with Retry. `loading` is "Not connected yet".
import type { AgentData } from '../agent/types'
import { notOnTeam } from './not-on-team'

export type StartScreen = 'app' | 'not-connected' | 'not-on-team' | 'signed-out' | 'load-error'

export function startScreen(data: Pick<AgentData, 'resources'>): StartScreen {
  const r = data.resources.meta
  if (r.status === 'ready') return 'app'
  if (r.status === 'loading') return 'not-connected'
  if (notOnTeam(data)) return 'not-on-team'
  return 'not-connected'
}
