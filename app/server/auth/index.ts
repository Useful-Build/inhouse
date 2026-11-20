// The API's sign-in and access parts (p2-design sections 1 to 3), as server/api.ts takes them (ApiParts):
// `authenticate` and `checkOrigin` (authenticate.ts), and `checkAccess` with `objectGate` (matrix.ts).
export { authenticate, authenticateUpgrade, checkOrigin } from './authenticate.ts'
export type { AuthOutcome } from './authenticate.ts'
export { AccessRefusedError, StoresClosedError, checkAccess, closedAfterRefusal, objectGate } from './matrix.ts'
export type { Principal } from './principal.ts'
export type { AuthStores } from './stores.ts'
