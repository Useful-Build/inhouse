// `decideCore` (N9; Stage 1 M3-L, N23): run, ask, exact or refuse, from the ceiling, the asker, the operation's flags,
// the call's counts and the grants. Pure, and property-tested (decide.property.test.ts, decide.table.test.ts). Its steps,
// in order:
//  1. the operation isn't enabled in the ceiling: refuse `over_ceiling`;
//  2. the call's units are past the ceiling's `units_max` (the largest single call, whatever approves it): refuse
//     `over_limit` ("over the limit the Inhouse team set");
//  3. no one to ask (a system routine): refuse `no_one_to_ask`;
//  4. a member asks for an operation their role can't approve (`memberMay: false`, a refund): `exact` with approver
//     `admins` (Stage 1 M3-X, N25), a card any active admin answers, first answer wins. Its guardrail is the effect's (or
//     `bulk`); an admin-only operation with neither says `access` (only admins may approve it). Never a grant, whatever
//     the origin. An admin's own call goes on (an exact card to themselves when an effect applies);
//  5. an effect flag, or more records than the ceiling's `bulk_threshold` (1 to 5, D3): `exact` with that guardrail,
//     never covered by "Always allow";
//  6. a routine: `ask` (routines use no grant, D4);
//  7. a live covering grant whose `units_max` admits the call's units: `run`;
//  8. a covering grant that doesn't admit them: `exact` with guardrail `count`;
//  9. otherwise `ask`, nudging toward "Always allow" after 3 "Allow once" answers in 30 days.
// The daily count isn't a fact here: the outbox's reservation (uses.ts) decides it atomically, and a `run` whose
// reservation fails becomes `exact` `count`. `claimGuardSql` (claim-guard.ts) states the same rules in SQL for the
// outbox's claim; a differential property test keeps the two equal.
import { NUDGE_AFTER, POLICY_REV } from './policy.ts'
import type { Asker, CeilingFacts, DecideCtx, DecideFacts, GrantFacts, Guardrail, Resolved, Verdict } from './types.ts'
import type { Effects } from '../outbox/operations/types.ts'

/**
 * The effect flags in the order they name a guardrail when several are set. `unreviewed` (Stage 1 M4, N46) is never set
 * beside another (its operation class forbids it). contract-coverage.test.ts checks this names every flag of `Effects`.
 */
export const EFFECT_GUARDRAILS: readonly (keyof Effects & Guardrail)[] = ['money', 'customer', 'destructive', 'access', 'unreviewed']

const RANK = { member: 0, admin: 1 } as const

/** The holder string of a member's own grants. */
export const memberHolder = (memberId: string): string => `member:${memberId}`

/**
 * Whether one grant covers this resolved action for this asker (steps 7 and 8; its `units_max` is checked apart): live;
 * held by the asker (their own chats and jobs) or by the brand; the same account, generation, operation and scope key;
 * made under the current ceiling and policy; and the asker's role at least the role it was granted under (a brand
 * grant: only an admin grants for the brand, D4).
 */
export function covers(g: GrantFacts, asker: Asker, r: Resolved, ceiling: CeilingFacts): boolean {
  if (g.revokedAtMs !== null) return false
  if (g.operation !== r.operation || g.accountId !== r.accountId || g.accountGen !== r.accountGen || g.scopeKey !== r.scopeKey) return false
  if (g.ceilingRev !== ceiling.loweredRev || g.policyRev !== POLICY_REV || r.policyRev !== POLICY_REV) return false
  if (g.holder === memberHolder(asker.memberId)) return RANK[asker.role] >= RANK[g.grantedRole]
  if (g.holder === 'brand') return g.grantedRole === 'admin'
  return false
}

/** Step 5: the guardrail this action needs under this ceiling, or null. */
export function guardrailOf(r: Pick<Resolved, 'effects' | 'records'>, ceiling: Pick<CeilingFacts, 'bulkThreshold'>): Guardrail | null {
  const flag = EFFECT_GUARDRAILS.find(k => r.effects[k])
  if (flag) return flag
  return r.records > ceiling.bulkThreshold ? 'bulk' : null
}

export function decideCore(f: DecideFacts, ctx: DecideCtx, r: Resolved): Verdict {
  const ceiling = Object.hasOwn(f.ceiling, r.operation) ? f.ceiling[r.operation] : undefined
  if (!ceiling || !ceiling.enabled) return { verdict: 'refuse', reason: 'over_ceiling' }
  if (r.units > ceiling.unitsMax) return { verdict: 'refuse', reason: 'over_limit' }
  const asker = ctx.asker
  if (asker === null) return { verdict: 'refuse', reason: 'no_one_to_ask' }
  const guardrail = guardrailOf(r, ceiling)
  // Stage 1 M3-X (N25): what a member's role can't approve is a card for any active admin (claimGuardSql's asker and
  // approver checks name the same rule), never a refusal and never a grant.
  if (asker.role === 'member' && !r.memberMay) return { verdict: 'exact', guardrail: guardrail ?? 'access', approver: 'admins' }
  if (guardrail) return { verdict: 'exact', guardrail, approver: 'asker' }
  if (ctx.origin === 'routine') return { verdict: 'ask', nudge: false }
  // The asker's own grant before the brand's, then by id: one answer for the same facts.
  const covering = f.grants.filter(g => covers(g, asker, r, ceiling))
    .sort((a, b) => Number(a.holder === 'brand') - Number(b.holder === 'brand') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // `units_max` is per call: the first covering grant that admits these units runs it.
  const admits = covering.find(g => r.units <= g.unitsMax)
  if (admits) return { verdict: 'run', grantId: admits.id }
  if (covering.length > 0) return { verdict: 'exact', guardrail: 'count', approver: 'asker' }
  return { verdict: 'ask', nudge: f.allowOnceCount >= NUDGE_AFTER }
}
