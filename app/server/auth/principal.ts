// Who made a request (p2-design section 1). `authenticate` builds one from a verified Access JWT and D1, fresh on every
// request (no cache across requests, so a removal or a grant's end applies to the very next one). Handlers get it
// verified and never re-derive a role from it. A person's and an Inhouse principal's `expMs` is the Access JWT's `exp`
// in ms (P3: the end of the window a socket attached under this sign-in may stay open, p3-design section 3).
export type { Role } from '../../shared/contract/me.ts'

/** A support grant (BD7) live at the request's time: Inhouse may read brand data until `endsAtMs` (exclusive). */
export type ActiveGrant = { id: string; endsAtMs: number }

export type Principal =
  /** A person on the brand app. `role` comes from their member row; `subject` is the Access `sub` it's bound to. */
  | { kind: 'person'; memberId: string; role: 'member' | 'admin'; subject: string; requestId: string; expMs: number }
  /** An Inhouse team member, only ever from the Inhouse Access application (hostname and `aud`), never an email row. */
  | { kind: 'inhouse'; memberId: string; subject: string; grant: ActiveGrant | null; requestId: string; expMs: number }
  /** The smoke test's Access service token, on the brand app; it has its own member row (kind `service`). */
  | { kind: 'service'; name: 'smoke'; memberId: string; requestId: string }
  /** The monitor's Access service token: health only, no member row, writes nothing. */
  | { kind: 'service'; name: 'monitor'; requestId: string }
  /**
   * The release job's Access service token (P3, p3-design section 3): only the rows that list it (drain and warm-up),
   * any method, brand host only, no member row. Its writes carry the brand `Origin` like any client's.
   */
  | { kind: 'service'; name: 'release'; requestId: string }

/** A principal with a member row: everyone but the `monitor` and `release` service tokens. */
export type MemberPrincipal = Exclude<Principal, { name: 'monitor' | 'release' }>
