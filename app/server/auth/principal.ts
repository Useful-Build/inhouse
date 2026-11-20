// Who made a request (p2-design section 1). `authenticate` builds one from a verified Access JWT and D1, fresh on every
// request (no cache across requests, so a removal or a grant's end applies to the very next one). Handlers get it
// verified and never re-derive a role from it.
export type { Role } from '../../shared/contract/me.ts'

/** A support grant (BD7) live at the request's time: Inhouse may read brand data until `endsAtMs` (exclusive). */
export type ActiveGrant = { id: string; endsAtMs: number }

export type Principal =
  /** A person on the brand app. `role` comes from their member row; `subject` is the Access `sub` it's bound to. */
  | { kind: 'person'; memberId: string; role: 'member' | 'admin'; subject: string; requestId: string }
  /** An Inhouse team member, only ever from the Inhouse Access application (hostname and `aud`), never an email row. */
  | { kind: 'inhouse'; memberId: string; subject: string; grant: ActiveGrant | null; requestId: string }
  /** The smoke test's Access service token, on the brand app; it has its own member row (kind `service`). */
  | { kind: 'service'; name: 'smoke'; memberId: string; requestId: string }
  /** The monitor's Access service token: health only, no member row, writes nothing. */
  | { kind: 'service'; name: 'monitor'; requestId: string }
