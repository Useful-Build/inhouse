// PR0's stand-ins for W1's auth (p2-design sections 1 to 3). W1 replaces this file: `authenticate` verifies the Access
// JWT (or the test issuer's, in the test build only) and reads the principal from D1; `checkOrigin` and `checkAccess`
// read the config and the matrix row. Until then every /api/* request is 401, so nothing past it can run.
import type { AccessRow } from '../access-matrix.ts'

/** Placeholder until W1's first PR freezes the principal type (p2-design section 1). */
export type Principal = { readonly kind: string; readonly requestId: string }

/** The verified principal, or null (401 `unauthorized`, the body never says why). Fails closed: always null for now. */
export async function authenticate(_request: Request, _env: Env, _requestId: string): Promise<Principal | null> {
  return null
}

/** Null when the request may go on; else the refusal's reason (403 `forbidden`). */
export function checkOrigin(_request: Request, _env: Env, _principal: Principal): string | null {
  return 'bad_origin'
}

/** Null when the matrix row lets this principal through; else the refusal. Fails closed until W1 lands. */
export function checkAccess(_row: AccessRow, _principal: Principal, _request: Request): { code: 'forbidden' | 'not_found'; reason?: string } | null {
  return { code: 'forbidden' }
}
