// `decideCore` and `resolve` under generated facts (fast-check; M2-A "Tests"). The operations are made-up resolved
// entries, so every flag (each effect, `memberMay`, the record count) is covered, not only the two real operations'.
// Invariants, written before the code:
//  I1. never `run` without a live grant that covers it (a reference `covering` written here, sharing no code with
//      decide.ts): live, held by the asker or the brand, same account, generation, operation and scope key, current
//      ceiling and policy revisions, and the asker's role at least the role it was granted under;
//  I2. never `run` or `ask` for a guardrail: any effect flag, or more than 5 records (D3), is `exact` (or a refusal
//      that comes before it), whatever grants exist;
//  I3. refuse outside the ceiling: no row, or a disabled one, is `over_ceiling`, whatever else holds;
//  I4. a routine never runs (D4: routines use no grant in M2);
//  I5. a member never runs or asks for an operation their role can't approve (`needs_admin`), and no one to ask is
//      `no_one_to_ask`;
//  I6. another member's grant never covers the asker (D4: a member's grant covers only their own chats);
//  I7. `ask` whenever the action passes steps 1 to 5 and no grant covers it; `nudge` exactly at 3 or more "Allow once";
//  I8. `resolve` refuses an unknown operation and arguments that don't parse, and never takes the account or its
//      generation from the arguments.
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { decideCore } from './decide.ts'
import { POLICY_REV } from './policy.ts'
import { resolve } from './resolve.ts'
import { OPS, ceilingsArb, ctxArb, grantArb, policyRevArb, recordsArb } from './test-arbitraries.ts'
import type { Asker, DecideFacts, GrantFacts, Resolved, ResolveFacts, WriteOperationKey } from './types.ts'

const ASKER_ID = 'm_asker'

const effectsArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ money: false, customer: false, destructive: false, access: false }) },
  { weight: 1, arbitrary: fc.record({ money: fc.boolean(), customer: fc.boolean(), destructive: fc.boolean(), access: fc.boolean() }) },
)
/** Made-up resolved entries: every flag drawn, not only the two real operations' values. */
const resolvedArb: fc.Arbitrary<Resolved> = fc.record({
  operation: fc.constantFrom(...OPS),
  accountId: fc.constantFrom('shopify:store', 'slack:workspace'),
  accountGen: fc.constantFrom(1_000, 2_000),
  scopeKey: fc.constantFrom('shop=store-a', 'channelId=C0123ABCD'),
  records: recordsArb,
  units: fc.integer({ min: 1, max: 5 }),
  effects: effectsArb,
  memberMay: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  policyRev: policyRevArb,
}).map(x => ({ ...x, args: {}, scope: {}, payloadHash: '0'.repeat(64) }))

const caseArb = fc.tuple(resolvedArb, ctxArb(ASKER_ID, true)).chain(([r, ctx]) => ceilingsArb(r.operation).chain(ceiling => fc.record({
  r: fc.constant(r),
  ctx: fc.constant(ctx),
  f: fc.record({
    ceiling: fc.constant(ceiling),
    grants: fc.integer({ min: 0, max: 4 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => grantArb(r, ceiling, ctx.asker, i, { other: 'm_other' })))),
    allowOnceCount: fc.integer({ min: 0, max: 5 }),
  }) as fc.Arbitrary<DecideFacts>,
})))

// ---------- the reference, written from N9's words ----------

const rank = (role: 'member' | 'admin') => (role === 'admin' ? 2 : 1)
/** I1's reference: which grants cover this action for this asker. */
function covering(f: DecideFacts, asker: Asker, r: Resolved): GrantFacts[] {
  const c = f.ceiling[r.operation]
  if (!c) return []
  return f.grants.filter(g => {
    const holderOk = g.holder === 'brand' ? g.grantedRole === 'admin' : g.holder === `member:${asker.memberId}` && rank(asker.role) >= rank(g.grantedRole)
    return holderOk && g.revokedAtMs === null && g.accountId === r.accountId && g.accountGen === r.accountGen &&
      g.operation === r.operation && g.scopeKey === r.scopeKey && g.ceilingRev === c.loweredRev &&
      g.policyRev === POLICY_REV && r.policyRev === POLICY_REV
  })
}
const guardrailed = (r: Resolved) => Object.values(r.effects).some(Boolean) || r.records > 5
const enabled = (f: DecideFacts, r: Resolved) => f.ceiling[r.operation]?.enabled === true

describe('decideCore', () => {
  test.prop([caseArb])('I1: never runs without a live covering grant, and runs under one when it may', ({ r, ctx, f }) => {
    const v = decideCore(f, ctx, r)
    if (v.verdict === 'run') {
      expect(ctx.asker).not.toBeNull()
      expect(covering(f, ctx.asker as Asker, r).map(g => g.id)).toContain(v.grantId)
    }
    if (enabled(f, r) && ctx.asker && (ctx.asker.role === 'admin' || r.memberMay) && !guardrailed(r) && ctx.origin !== 'routine' && covering(f, ctx.asker, r).length > 0) {
      expect(v.verdict).toBe('run')
    }
  })

  test.prop([caseArb])('I2: a guardrail is never run or ask: exact, or a refusal that comes first', ({ r, ctx, f }) => {
    fc.pre(guardrailed(r))
    const v = decideCore(f, ctx, r)
    expect(['exact', 'refuse']).toContain(v.verdict)
    if (v.verdict === 'exact') expect(v.guardrail).toBe(Object.values(r.effects).some(Boolean) ? ['money', 'customer', 'destructive', 'access'].find(k => r.effects[k as keyof typeof r.effects]) : 'bulk')
  })

  test.prop([caseArb])('I3: outside the ceiling is over_ceiling, whatever else holds', ({ r, ctx, f }) => {
    fc.pre(!enabled(f, r))
    expect(decideCore(f, ctx, r)).toEqual({ verdict: 'refuse', reason: 'over_ceiling' })
  })

  test.prop([caseArb])('I4: a routine never runs', ({ r, ctx, f }) => {
    expect(decideCore(f, { ...ctx, origin: 'routine' }, r).verdict).not.toBe('run')
  })

  test.prop([caseArb])('I5: no one to ask, and a member asking for what their role can\'t approve, are refused', ({ r, ctx, f }) => {
    fc.pre(enabled(f, r))
    expect(decideCore(f, { ...ctx, asker: null }, r)).toEqual({ verdict: 'refuse', reason: 'no_one_to_ask' })
    expect(decideCore(f, { ...ctx, asker: { memberId: ASKER_ID, role: 'member' } }, { ...r, memberMay: false })).toEqual({ verdict: 'refuse', reason: 'needs_admin' })
  })

  test.prop([caseArb])('I6: another member\'s grant never covers the asker', ({ r, ctx, f }) => {
    const others = { ...f, grants: f.grants.filter(g => g.holder === 'member:m_other') }
    expect(decideCore(others, ctx, r).verdict).not.toBe('run')
  })

  test.prop([caseArb])('I7: ask when nothing refuses, no guardrail and no grant covers; nudge from 3 Allow once', ({ r, ctx, f }) => {
    fc.pre(enabled(f, r) && ctx.asker !== null && (ctx.asker.role === 'admin' || r.memberMay) && !guardrailed(r))
    const asker = ctx.asker as Asker
    const v = decideCore(f, ctx, r)
    if (ctx.origin === 'routine') expect(v).toEqual({ verdict: 'ask', nudge: false })
    else if (covering(f, asker, r).length === 0) expect(v).toEqual({ verdict: 'ask', nudge: f.allowOnceCount >= 3 })
  })
})

// ---------- resolve ----------

const facts = (over: Partial<ResolveFacts> = {}): ResolveFacts => ({
  nowMs: 1_800_000_000_000,
  accounts: {
    shopify: { accountId: 'shopify:store', connectedAtMs: 1_000, connected: true, paused: false, label: 'Shopify (Store A)', shop: 'store-a' },
    slack: { accountId: 'slack:workspace', connectedAtMs: 2_000, connected: true, paused: false, label: 'Slack', shop: null },
  },
  listedChannels: [{ id: 'C0123ABCD', name: 'ops' }],
  ...over,
})
const validArgs = {
  'shopify.order.tag_add': { orderId: 'gid://shopify/Order/42', tags: ['vip'] },
  'slack.channel.post': { channel: '#ops', text: 'Restock done' },
} as const

describe('resolve (I8)', () => {
  test.prop([fc.string().filter(s => !OPS.includes(s as WriteOperationKey)), fc.anything()])('refuses an unknown operation', async (op, args) => {
    expect(await resolve(facts(), { operation: op as WriteOperationKey, args })).toEqual({ refuse: { verdict: 'refuse', reason: 'unknown_operation' } })
  })

  test.prop([fc.constantFrom(...OPS), fc.anything().filter(a => typeof a !== 'object' || a === null || Array.isArray(a))])('refuses arguments that aren\'t an object', async (op, args) => {
    expect(await resolve(facts(), { operation: op, args })).toEqual({ refuse: { verdict: 'refuse', reason: 'invalid_args' } })
  })

  test.prop([fc.constantFrom(...OPS), fc.dictionary(fc.constantFrom('accountId', 'accountGen', 'connectedAtMs', 'shop', 'extra'), fc.jsonValue(), { minKeys: 1 })])(
    'refuses any extra key (the account never comes from the arguments)',
    async (op, extra) => {
      expect(await resolve(facts(), { operation: op, args: { ...validArgs[op], ...extra } })).toEqual({ refuse: { verdict: 'refuse', reason: 'invalid_args' } })
    },
  )

  test.prop([fc.constantFrom(...OPS), fc.integer({ min: 1, max: 9e12 })])('takes the account and its generation from the connected account', async (op, gen) => {
    const f = facts()
    const key = op === 'slack.channel.post' ? 'slack' : 'shopify'
    const got = await resolve({ ...f, accounts: { ...f.accounts, [key]: { ...f.accounts[key]!, connectedAtMs: gen } } }, { operation: op, args: validArgs[op] })
    expect(got).toMatchObject({ operation: op, accountId: f.accounts[key]!.accountId, accountGen: gen, policyRev: POLICY_REV, records: 1, units: 1 })
  })
})
