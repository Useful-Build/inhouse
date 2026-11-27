// `decideCore` over every combination, not a sample (review round 1: at 100 random runs, dropping the generation check
// from `covers` passed 1 time in 6). One grant per case, built as one that covers the action and then given exactly
// one perturbation (another holder, the brand at either role, another account, generation, operation or scope, an old
// policy or ceiling revision, a higher granted role, revoked), crossed with every asker (member, admin, none), origin,
// ceiling state, record count either side of the bulk line, `memberMay`, an effect flag, the action's policy revision,
// the role the asker's own grant was made at, and the Allow once count either side of the nudge. The oracle is the
// scenario's meaning, written here from N9's words: which perturbations still cover, and for whom.
import { describe, expect, it } from 'vitest'
import { decideCore } from './decide.ts'
import { POLICY_REV } from './policy.ts'
import { M2_CEILING_LIMITS } from './test-arbitraries.ts'
import type { Asker, CeilingFacts, DecideCtx, GrantFacts, Origin, Resolved, Verdict } from './types.ts'

const PERTURBATIONS = ['none', 'holder_other', 'holder_brand_member', 'holder_brand_admin', 'account', 'gen', 'operation', 'scope', 'policy', 'role', 'ceiling', 'revoked'] as const
type Perturbation = (typeof PERTURBATIONS)[number]
const CEILINGS = ['enabled_rev1', 'enabled_rev2', 'disabled', 'absent'] as const

function grantFor(p: Perturbation, r: Resolved, loweredRev: number, mineRole: 'member' | 'admin'): GrantFacts {
  const g: GrantFacts = {
    id: 'pg_tableAAAAAAAAAAAAAAAAA', holder: 'member:m_asker', accountId: r.accountId, accountGen: r.accountGen, operation: r.operation,
    scopeKey: r.scopeKey, perDay: 5, unitsMax: 1, policyRev: POLICY_REV, grantedRole: mineRole, ceilingRev: loweredRev, revokedAtMs: null,
  }
  switch (p) {
    case 'none': return g
    case 'holder_other': return { ...g, holder: 'member:m_other' }
    case 'holder_brand_member': return { ...g, holder: 'brand', grantedRole: 'member' }
    case 'holder_brand_admin': return { ...g, holder: 'brand', grantedRole: 'admin' }
    case 'account': return { ...g, accountId: 'shopify:other' }
    case 'gen': return { ...g, accountGen: r.accountGen + 1 }
    case 'operation': return { ...g, operation: 'slack.channel.post' }
    case 'scope': return { ...g, scopeKey: 'shop=store-b' }
    case 'policy': return { ...g, policyRev: POLICY_REV + 1 }
    case 'role': return { ...g, grantedRole: 'admin' }
    case 'ceiling': return { ...g, ceilingRev: loweredRev + 1 }
    case 'revoked': return { ...g, revokedAtMs: 1 }
  }
}

/** Whether the scenario's grant covers, from its meaning: the asker's own at or below their role, or an admin's brand grant. */
function stillCovers(p: Perturbation, asker: Asker, mineRole: 'member' | 'admin'): boolean {
  if (p === 'none') return asker.role === 'admin' || mineRole === 'member'
  if (p === 'holder_brand_admin') return true
  if (p === 'role') return asker.role === 'admin'
  return false
}

describe('decideCore, every combination', () => {
  it('gives the scenario\'s verdict in all of them', () => {
    let cases = 0
    const counts: Record<Verdict['verdict'], number> = { run: 0, ask: 0, exact: 0, refuse: 0 }
    for (const p of PERTURBATIONS) for (const askerRole of ['member', 'admin', null] as const) for (const origin of ['chat', 'job', 'routine'] as Origin[])
      for (const c of CEILINGS) for (const records of [5, 6]) for (const memberMay of [true, false]) for (const money of [false, true])
        for (const policyRev of [POLICY_REV, POLICY_REV + 1]) for (const mineRole of ['member', 'admin'] as const) for (const allowOnce of [2, 3]) {
          const r: Resolved = {
            operation: 'shopify.order.tag_add', args: {}, accountId: 'shopify:store', accountGen: 1_000, scope: {}, scopeKey: 'shop=store-a',
            records, units: 1, effects: { money, customer: false, destructive: false, access: false }, memberMay, payloadHash: '0'.repeat(64), policyRev,
          }
          const loweredRev = c === 'enabled_rev2' ? 2 : 1
          const ceiling: CeilingFacts | undefined = c === 'absent' ? undefined : { enabled: c !== 'disabled', perDayMax: 50, loweredRev, ...M2_CEILING_LIMITS }
          const asker: Asker | null = askerRole === null ? null : { memberId: 'm_asker', role: askerRole }
          const ctx: DecideCtx = { asker, origin, chatId: 'c_t', nowMs: 1 }
          const g = grantFor(p, r, loweredRev, mineRole)
          const got = decideCore({ ceiling: ceiling ? { 'shopify.order.tag_add': ceiling } : {}, grants: [g], allowOnceCount: allowOnce }, ctx, r)

          let want: Verdict
          if (!ceiling?.enabled) want = { verdict: 'refuse', reason: 'over_ceiling' }
          else if (asker === null) want = { verdict: 'refuse', reason: 'no_one_to_ask' }
          else if (asker.role === 'member' && !memberMay) want = { verdict: 'refuse', reason: 'needs_admin' }
          else if (money) want = { verdict: 'exact', guardrail: 'money', approver: 'asker' }
          else if (records > 5) want = { verdict: 'exact', guardrail: 'bulk', approver: 'asker' }
          else if (origin === 'routine') want = { verdict: 'ask', nudge: false }
          else if (policyRev === POLICY_REV && stillCovers(p, asker, mineRole)) want = { verdict: 'run', grantId: g.id }
          else want = { verdict: 'ask', nudge: allowOnce >= 3 }
          expect(got, JSON.stringify({ p, askerRole, origin, c, records, memberMay, money, policyRev, mineRole, allowOnce })).toEqual(want)
          counts[got.verdict]++
          cases++
        }
    expect(cases).toBe(PERTURBATIONS.length * 3 * 3 * CEILINGS.length * 2 * 2 * 2 * 2 * 2 * 2)
    for (const v of ['run', 'ask', 'exact', 'refuse'] as const) expect(counts[v], v).toBeGreaterThan(0)
  })
})
