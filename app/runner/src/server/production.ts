// The production wiring of the guards seam: R2's implementations (src/guards/). `requireProduction` refuses any
// implementation not marked production, so the test implementation (test/run/support/) can never be wired in here.
import { readFileSync } from 'node:fs'
import { auditTransportMissing } from '../guards/audit.ts'
import { createSessionHost } from '../guards/host.ts'
import { createQueryGuards } from '../guards/options.ts'
import { createSessionPool, readPool } from '../guards/users.ts'
import { hostAddresses } from '../proxy/proc-net.ts'
import type { QueryGuards, SessionUsers } from '../session/seam.ts'

export class GuardsMissingError extends Error {}

export function requireProduction<T extends { kind: string }>(impl: T | undefined, name: string): T {
  if (impl === undefined) throw new GuardsMissingError(`${name}: no implementation installed; refusing to start without the guards`)
  if (impl.kind !== 'production') throw new GuardsMissingError(`${name}: "${impl.kind}" implementation refused; production needs the real guards`)
  return impl
}

/** The root's seam: one OS user per session, from the image's pool. Throws (the root doesn't start) on a broken pool. */
export function productionSessionUsers(): SessionUsers {
  const pool = readPool(readFileSync('/etc/passwd', 'utf8'))
  const host = createSessionHost({ poolUids: new Set(pool.map((u) => u.uid)) })
  return requireProduction<SessionUsers>(createSessionPool(pool, host), 'SessionUsers')
}

/**
 * The session process's seam: the guards around `query()`. The audit transport is R1's second PR; until it's wired,
 * `auditTransportMissing` refuses every entry, so every tool call is blocked rather than run unrecorded.
 */
export function productionQueryGuards(): QueryGuards {
  return requireProduction<QueryGuards>(createQueryGuards({ audit: auditTransportMissing, hostAddresses }), 'QueryGuards')
}
