// `decideCore` (N9): run, ask, exact or refuse, from the ceiling, the asker, the operation's flags and the grants. Pure,
// and property-tested (decide.property.test.ts). Its steps, in order:
//  1. the operation isn't enabled in the ceiling: refuse `over_ceiling`;
//  2. no one to ask (a system routine): refuse `no_one_to_ask`;
//  3. a member asks for an operation their role can't approve: refuse `needs_admin` (M3 adds the admin's card);
//  4. an effect flag, or more than 5 records (D3): `exact` with that guardrail, never covered by "Always allow";
//  5. a routine: `ask` (routines use no grant in M2, D4);
//  6. a live grant covers it: `run`;
//  7. otherwise `ask`, nudging toward "Always allow" after 3 "Allow once" answers in 30 days.
// `claimGuardSql` (claim-guard.ts) states the same rules in SQL for the outbox's claim; a differential property test
// keeps the two equal.
import { BULK_RECORDS, NUDGE_AFTER, POLICY_REV } from './policy.ts'
import type { Asker, CeilingFacts, DecideCtx, DecideFacts, GrantFacts, Guardrail, Resolved, Verdict } from './types.ts'
import type { Effects } from '../outbox/operations/types.ts'

/** The effect flags in the order they name a guardrail when several are set. */
export const EFFECT_GUARDRAILS: readonly (keyof Effects & Guardrail)[] = ['money', 'customer', 'destructive', 'access']

const RANK = { member: 0, admin: 1 } as const

/** The holder string of a member's own grants. */
export const memberHolder = (memberId: string): string => `member:${memberId}`

/**
 * Whether one grant covers this resolved action for this asker (step 6): live; held by the asker (their own chats and
 * jobs) or by the brand; the same account, generation, operation and scope key; made under the current ceiling and
 * policy; and the asker's role at least the role it was granted under (a brand grant: only an admin grants for the
 * brand, D4).
 */
export function covers(g: GrantFacts, asker: Asker, r: Resolved, ceiling: CeilingFacts): boolean {
  if (g.revokedAtMs !== null) return false
  if (g.operation !== r.operation || g.accountId !== r.accountId || g.accountGen !== r.accountGen || g.scopeKey !== r.scopeKey) return false
  if (g.ceilingRev !== ceiling.loweredRev || g.policyRev !== POLICY_REV || r.policyRev !== POLICY_REV) return false
  if (g.holder === memberHolder(asker.memberId)) return RANK[asker.role] >= RANK[g.grantedRole]
  if (g.holder === 'brand') return g.grantedRole === 'admin'
  return false
}

/** Step 4: the guardrail this action needs, or null. */
export function guardrailOf(r: Pick<Resolved, 'effects' | 'records'>): Guardrail | null {
  const flag = EFFECT_GUARDRAILS.find(k => r.effects[k])
  if (flag) return flag
  return r.records > BULK_RECORDS ? 'bulk' : null
}

export function decideCore(f: DecideFacts, ctx: DecideCtx, r: Resolved): Verdict {
  const ceiling = Object.hasOwn(f.ceiling, r.operation) ? f.ceiling[r.operation] : undefined
  if (!ceiling || !ceiling.enabled) return { verdict: 'refuse', reason: 'over_ceiling' }
  const asker = ctx.asker
  if (asker === null) return { verdict: 'refuse', reason: 'no_one_to_ask' }
  if (asker.role === 'member' && !r.memberMay) return { verdict: 'refuse', reason: 'needs_admin' }
  const guardrail = guardrailOf(r)
  // Stage 1 M3-A: every exact card is the asker's until M3-X adds the admins' card (N25).
  if (guardrail) return { verdict: 'exact', guardrail, approver: 'asker' }
  if (ctx.origin === 'routine') return { verdict: 'ask', nudge: false }
  // The asker's own grant before the brand's, then by id: one answer for the same facts.
  const covering = f.grants.filter(g => covers(g, asker, r, ceiling))
    .sort((a, b) => Number(a.holder === 'brand') - Number(b.holder === 'brand') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (covering.length > 0) return { verdict: 'run', grantId: covering[0].id }
  return { verdict: 'ask', nudge: f.allowOnceCount >= NUDGE_AFTER }
}
