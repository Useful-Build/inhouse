// The app's one address bar: the browser's, with a record of what the app wrote (see route-sync.ts). Every write of the hash
// goes through `hashBar`; no other file calls history.replaceState or history.pushState (hash-bar.test.ts).
import { createHashBar } from './route-sync'

export const hashBar = createHashBar({
  hash: () => location.hash,
  state: () => history.state,
  replace: (state, hash) => history.replaceState(state, '', hash),
  push: (state, hash) => history.pushState(state, '', hash),
})
