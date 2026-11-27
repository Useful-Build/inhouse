// fast-check generators for the permission property tests. Never imported by the Worker. A grant starts as one that
// covers the action and then gets at most one perturbation (another holder, account, generation, operation, scope, an
// old policy or ceiling revision, a higher granted role, revoked), so both sides of every rule are drawn often; a
// generator of independent random fields almost never draws a covering grant.
import { fc } from '@fast-check/vitest'
import { POLICY_REV } from './policy.ts'
import type { Asker, CeilingFacts, DecideCtx, GrantFacts, Resolved, WriteOperationKey } from './types.ts'

export const OPS: readonly WriteOperationKey[] = ['shopify.order.tag_add', 'slack.channel.post', 'shopify.order.tag_remove', 'shopify.draft_order.create',
  'shopify.inventory.restock', 'shopify.inventory.reduce', 'shopify.refund.create']

export type Ceilings = Partial<Record<WriteOperationKey, CeilingFacts>>

/** Records around the bulk lines (1 to 5) as often as far from them. */
export const recordsArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 6 }) },
  { weight: 1, arbitrary: fc.constantFrom(5, 6) },
  { weight: 1, arbitrary: fc.integer({ min: 6, max: 500 }) },
)

/** A call's units: small most of the time (so grants admit them), sometimes past every limit drawn. */
export const unitsArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 3 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 10 }) },
)

/** A largest-call limit (ceiling or grant): above most calls most of the time, at or below them sometimes. */
export const unitsMaxArb = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 3, max: 10 }) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 3 }) },
)

/**
 * Stage 1 M3-L: the ceiling's M3 limits (N23), drawn: the largest call around the drawn units, the bulk threshold 1 to 5
 * (D3's 5 half the time, so a grant can still cover a few records), any batch size, any row revision.
 */
export const ceilingLimitsArb = fc.record({
  unitsMax: unitsMaxArb,
  bulkThreshold: fc.oneof({ weight: 1, arbitrary: fc.constant(5) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 5 }) }),
  batchMax: fc.integer({ min: 1, max: 500 }),
  rev: fc.integer({ min: 1, max: 3 }),
})

/** The ceiling's M3 limits at 0760's defaults (M2's rules: one unit per call, bulk past 5, batches of 500). */
export const M2_CEILING_LIMITS = { unitsMax: 1, bulkThreshold: 5, batchMax: 500, rev: 1 } as const

/** The ceilings: the action's operation enabled most of the time, either revision; the other one anything or absent. */
export const ceilingsArb = (op: WriteOperationKey): fc.Arbitrary<Ceilings> => fc.record({
  mine: fc.oneof(
    { weight: 4, arbitrary: fc.record({ enabled: fc.constant(true), perDayMax: fc.integer({ min: 1, max: 50 }), loweredRev: fc.integer({ min: 1, max: 2 }), limits: ceilingLimitsArb }).map(({ limits, ...c }) => ({ ...c, ...limits })) },
    { weight: 1, arbitrary: fc.record({ enabled: fc.constant(false), perDayMax: fc.integer({ min: 1, max: 50 }), loweredRev: fc.integer({ min: 1, max: 2 }), limits: ceilingLimitsArb }).map(({ limits, ...c }) => ({ ...c, ...limits })) },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
  other: fc.option(fc.record({ enabled: fc.boolean(), perDayMax: fc.integer({ min: 1, max: 50 }), loweredRev: fc.integer({ min: 1, max: 2 }), limits: ceilingLimitsArb }).map(({ limits, ...c }) => ({ ...c, ...limits })), { nil: null }),
}).map(({ mine, other }) => {
  const out: Ceilings = {}
  if (mine) out[op] = mine
  const otherOp = OPS.find(o => o !== op)!
  if (other) out[otherOp] = other
  return out
})

const PERTURB = ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'holder_other', 'holder_brand', 'account', 'gen', 'operation', 'scope', 'policy', 'role', 'ceiling', 'revoked'] as const

/** One grant for this action: covering, or covering but for one perturbation. */
export const grantArb = (r: Resolved, ceilings: Ceilings, asker: Asker | null, i: number, ids: { other: string }): fc.Arbitrary<GrantFacts> =>
  fc.record({ p: fc.constantFrom(...PERTURB), perDay: fc.integer({ min: 1, max: 50 }), unitsMax: unitsMaxArb, brandRole: fc.constantFrom('member' as const, 'admin' as const), mineRole: fc.constantFrom('member' as const, 'admin' as const) }).map(({ p, perDay, unitsMax, brandRole, mineRole }) => {
    const loweredRev = ceilings[r.operation]?.loweredRev ?? 1
    const askerId = asker?.memberId ?? 'm_nobody'
    // A covering grant for the asker: granted at or below their role.
    const role = asker?.role === 'admin' ? mineRole : 'member'
    const g: GrantFacts = {
      id: `pg_t${String(i).padStart(21, '0')}`, holder: `member:${askerId}`, accountId: r.accountId, accountGen: r.accountGen,
      operation: r.operation, scopeKey: r.scopeKey, perDay, unitsMax, policyRev: POLICY_REV, grantedRole: role, ceilingRev: loweredRev, revokedAtMs: null,
    }
    switch (p) {
      case 'none': return g
      case 'holder_other': return { ...g, holder: `member:${ids.other}` }
      case 'holder_brand': return { ...g, holder: 'brand', grantedRole: brandRole }
      case 'account': return { ...g, accountId: `${r.accountId}x` }
      case 'gen': return { ...g, accountGen: r.accountGen + 1 }
      case 'operation': return { ...g, operation: OPS.find(o => o !== r.operation)! }
      case 'scope': return { ...g, scopeKey: `${r.scopeKey}x` }
      case 'policy': return { ...g, policyRev: POLICY_REV + 1 }
      case 'role': return { ...g, grantedRole: 'admin' }
      case 'ceiling': return { ...g, ceilingRev: loweredRev + 1 }
      case 'revoked': return { ...g, revokedAtMs: 5 }
    }
  })

export const originArb = fc.constantFrom('chat' as const, 'job' as const, 'chat' as const, 'routine' as const)

export const ctxArb = (askerId: string, withNull: boolean): fc.Arbitrary<DecideCtx> => fc.record({
  asker: withNull
    ? fc.oneof({ weight: 6, arbitrary: fc.record({ memberId: fc.constant(askerId), role: fc.constantFrom('member' as const, 'admin' as const) }) }, { weight: 1, arbitrary: fc.constant(null) })
    : fc.record({ memberId: fc.constant(askerId), role: fc.constantFrom('member' as const, 'admin' as const) }),
  origin: originArb,
  chatId: fc.constant('c_chat'),
  nowMs: fc.constant(1_800_000_000_000),
})

/** The action's policy revision: current most of the time. */
export const policyRevArb = fc.oneof({ weight: 4, arbitrary: fc.constant(POLICY_REV) }, { weight: 1, arbitrary: fc.constant(POLICY_REV + 1) })
