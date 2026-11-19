// The production wiring of the guards seam. The real implementations are R2's (src/guards/). Until they exist this
// refuses, so a production runner can't start without its guards. `requireProduction` also refuses any implementation
// not marked production, so the test implementation (test/run/support/) can never be wired in here.
import type { QueryGuards, SessionUsers } from '../session/seam.ts'

export class GuardsMissingError extends Error {}

export function requireProduction<T extends { kind: string }>(impl: T | undefined, name: string): T {
  if (impl === undefined) throw new GuardsMissingError(`${name}: no implementation installed; refusing to start without the guards`)
  if (impl.kind !== 'production') throw new GuardsMissingError(`${name}: "${impl.kind}" implementation refused; production needs the real guards`)
  return impl
}

/** The root's seam: one OS user per session. R2 replaces `undefined` with the real `SessionUsers`. */
export function productionSessionUsers(): SessionUsers {
  return requireProduction<SessionUsers>(undefined, 'SessionUsers')
}

/** The session process's seam: the guards around `query()`. R2 replaces `undefined` with the real `QueryGuards`. */
export function productionQueryGuards(): QueryGuards {
  return requireProduction<QueryGuards>(undefined, 'QueryGuards')
}
