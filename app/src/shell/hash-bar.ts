// The app's one address bar: the browser's, with a record of what the app wrote (see route-sync.ts). Every write of the hash
// goes through `hashBar`; no other file calls history.replaceState or history.pushState (build-support/route-sync-wiring.test.ts).
import { createHashBar } from './route-sync'

/**
 * The sign-in return's address (`/tools/slack?connected=1`, W1's route B) becomes the app's own (`/#/tools/slack`): the one
 * write that changes the path and drops the query, so the code and state in it don't stay in the address bar or the history.
 */
export const leaveSignInReturn = (hash: string): void => history.replaceState(history.state, '', `/${hash}`)

export const hashBar = createHashBar({
  hash: () => location.hash,
  state: () => history.state,
  replace: (state, hash) => history.replaceState(state, '', hash),
  push: (state, hash) => history.pushState(state, '', hash),
})
