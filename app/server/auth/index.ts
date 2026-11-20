// The API's sign-in and access parts (p2-design sections 1 to 3), as server/api.ts takes them (ApiParts):
// `authenticate` and `checkOrigin` (authenticate.ts), and `checkAccess` with `objectGate` (matrix.ts).
import type { AuthStores } from './stores.ts'

export { authenticate, authenticateUpgrade, checkOrigin } from './authenticate.ts'
export type { AuthOutcome } from './authenticate.ts'
export { AccessRefusedError, StoresClosedError, checkAccess, closedAfterRefusal, objectGate } from './matrix.ts'
export type { Principal } from './principal.ts'
export type { AuthStores } from './stores.ts'

const unwired = () => Promise.reject(new Error('stores not wired'))

/**
 * Stand-in stores until W2's D1 data layer is wired (server/index.ts): every call throws, so every sign-in that needs
 * D1 answers 503 and nothing is let through. Only `monitor` (no member row) gets a principal.
 */
export const unwiredStores: AuthStores = {
  members: { resolvePerson: unwired, resolveInhouse: unwired, serviceMember: unwired, profile: unwired },
  grants: { active: unwired },
  audit: { supportAccess: unwired },
}
