// What `authenticate` and `checkAccess` need from D1 (p2-design sections 1, 7 and 8). W2 implements these over D1;
// W1's code and tests take them as arguments (tests pass in-memory fakes). Every method reads D1 fresh: no cache.
import type { ActiveGrant, Principal } from './principal.ts'

/** What a sign-in carries: the verified token's `sub` and email (lower-cased and trimmed by the caller). */
export interface SignIn {
  subject: string
  email: string
  requestId: string
  nowMs: number
}

/**
 * Why a brand-app sign-in gets no principal: each answers 403 with that `reason`. `wrong_kind` is a subject bound to an
 * `inhouse` or `service` row (P8a P-auth: it was 401, which the client can't tell from an ended session, so it showed
 * "Sign in again" and looped). The answer is the reason alone: no member id, name or email.
 */
export type SignInRefusal = 'not_invited' | 'removed' | 'wrong_kind'

type InhousePrincipal = Extract<Principal, { kind: 'inhouse' }>

export interface MemberDirectory {
  /**
   * A person on the brand app (p2-design section 7, "Sign-in binding"): the row bound to `subject`, else binds an open
   * invite for `email` once (writing `member.bound` in the same batch). Never yields an `inhouse` or `service` principal.
   */
  resolvePerson(signIn: SignIn): Promise<{ ok: Omit<Extract<Principal, { kind: 'person' }>, 'expMs'> } | { refused: SignInRefusal }>
  /**
   * An Inhouse team member (Inhouse app only): the `inhouse` row for `subject`, or a new one with
   * `inhouse.first_sign_in`. Returns the principal **without** its grant: `authenticate` is the one caller of
   * `GrantStore.active` and attaches the grant itself. `expMs` (both methods) comes from the token, so `authenticate`
   * adds it too.
   */
  resolveInhouse(signIn: SignIn): Promise<Omit<InhousePrincipal, 'grant' | 'expMs'>>
  /** The member id of a service's own row (only `smoke` has one; `monitor` has none). */
  serviceMember(name: 'smoke'): Promise<string>
  /** What `GET /api/me` shows of a member, or null when there's no such row. */
  profile(memberId: string): Promise<{ name: string; email: string | null; photoKey: string | null } | null>
}

export interface GrantStore {
  /**
   * The support grant live at `nowMs` (`ends_at_ms > nowMs`, not ended), or null. Called once per Inhouse request, by
   * `authenticate` only; it may write the expiry line of a grant that has just ended (with `requestId`).
   */
  active(at: { nowMs: number; requestId: string }): Promise<ActiveGrant | null>
}

export interface AuditSink {
  /**
   * Writes the `support.access` line for an Inhouse read of brand data, before the handler runs, at the request's one
   * `nowMs`. Throws when the line can't be written: the request then answers 503 `unavailable` with no data.
   */
  supportAccess(principal: InhousePrincipal, at: { method: string; route: string; nowMs: number }): Promise<void>
}

/**
 * The stores, as `authenticate` and every handler get them (a handler through `closedAfterRefusal`). The contract
 * (W2): every method takes data and returns data. No method hands out a writer (a transaction or batch callback, a
 * statement or batch builder, a sub-store or handle returned from a call): `closedAfterRefusal` checks only when a
 * method is called, so a writer handed out before an object check refused would still write after it.
 */
export interface AuthStores {
  members: MemberDirectory
  grants: GrantStore
  audit: AuditSink
}
