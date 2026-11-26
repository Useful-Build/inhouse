// `claimGuardSql` against `decideCore` on random D1 states (fast-check, D1 in the Workers pool; N9's differential test).
// Each case writes a ceiling, grants (live and revoked), the asker and another member, the connected account and the
// listed channel, then asks the guard about an `outbox_actions`-shaped row (a CTE; the outbox's table is M2-B's).
// Invariants, written before the code:
//  D1. a grant-backed row (`grant_id` set, its use reserved) passes the guard exactly when `decideCore`, given that one
//      grant, says `run` with it;
//  D2. a row a person approved (no grant, the asker approving) passes exactly when `decideCore` doesn't refuse and the
//      row's policy revision is current;
//  D3. the claim's extra checks: a removed asker, a reconnected or disconnected account, an unlisted channel, a
//      released use, a missing use and a routine's grant-backed row each fail the guard (unit cases at the end).
import { fc } from '@fast-check/vitest'
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it } from 'vitest'
import { OPERATIONS } from '../outbox/operations/index.ts'
import { claimGuardSql } from './claim-guard.ts'
import type { GuardTable } from './claim-guard.ts'
import { decideCore } from './decide.ts'
import { POLICY_REV } from './policy.ts'
import { account, ceiling, channel, insertGrant, person, resetPermissions, storable } from './test-support.ts'
import { OPS, ceilingsArb, ctxArb, grantArb, policyRevArb, recordsArb } from './test-arbitraries.ts'
import type { Asker, DecideCtx, DecideFacts, GrantFacts, Origin, Resolved, WriteOperationKey } from './types.ts'

const db = env.DB
const ASKER = 'm_claim_asker'
const OTHER = 'm_claim_other'
const CHANNEL = 'C0CLAIM0001'
const ACCOUNT: Record<WriteOperationKey, string> = { 'shopify.order.tag_add': 'shopify:store', 'slack.channel.post': 'slack:workspace' }
const SCOPE: Record<WriteOperationKey, Record<string, string>> = { 'shopify.order.tag_add': { shop: 'store-a' }, 'slack.channel.post': { channelId: CHANNEL } }
const scopeKey = (s: Record<string, string>) => Object.entries(s).map(([k, v]) => `${k}=${v}`).join('&')

interface Row {
  id: string; rev: number; verdict: 'run' | 'ask' | 'exact'; origin: Origin; asked_by: string; approved_by: string | null
  grant_id: string | null; account_id: string; account_gen: number; operation: string; policy_rev: number
  scope_key: string; scope_json: string; records: number
}
const COLS: readonly (keyof Row)[] = ['id', 'rev', 'verdict', 'origin', 'asked_by', 'approved_by', 'grant_id', 'account_id', 'account_gen', 'operation', 'policy_rev', 'scope_key', 'scope_json', 'records']

async function passes(row: Row, table: GuardTable = OPERATIONS): Promise<boolean> {
  const g = claimGuardSql('a', table)
  const n = await db.prepare(`WITH a AS (SELECT ${COLS.map(c => `? AS ${c}`).join(', ')}) SELECT COUNT(*) AS n FROM a WHERE ${g.sql}`)
    .bind(...COLS.map(c => row[c]), ...g.params).first<number>('n')
  return n === 1
}

const rowOf = (r: Resolved, ctx: DecideCtx & { asker: Asker }, over: Partial<Row>): Row => ({
  id: 'ac_claim', rev: 1, verdict: 'ask', origin: ctx.origin, asked_by: ctx.asker.memberId, approved_by: ctx.asker.memberId,
  grant_id: null, account_id: r.accountId, account_gen: r.accountGen, operation: r.operation, policy_rev: r.policyRev,
  scope_key: r.scopeKey, scope_json: JSON.stringify(r.scope), records: r.records, ...over,
})

// ---------- generators: the real operations with made-up flags (the guard reads them from the table it's given, so its
// `memberMay` and effect branches run), random everything else ----------

const NO_EFFECTS = { money: false, customer: false, destructive: false, access: false }
const flagsArb = fc.record({
  memberMay: fc.oneof({ weight: 3, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }),
  effects: fc.oneof({ weight: 3, arbitrary: fc.constant(NO_EFFECTS) }, { weight: 1, arbitrary: fc.record({ money: fc.boolean(), customer: fc.boolean(), destructive: fc.boolean(), access: fc.boolean() }) }),
})
const tableArb: fc.Arbitrary<GuardTable> = fc.record({ shop: flagsArb, slack: flagsArb }).map(({ shop, slack }) => ({
  'shopify.order.tag_add': { connector: 'shopify', ...shop },
  'slack.channel.post': { connector: 'slack', ...slack },
}))
const resolvedArb = (table: GuardTable): fc.Arbitrary<Resolved> => fc.record({
  operation: fc.constantFrom(...OPS),
  accountGen: fc.constantFrom(1_000, 2_000),
  records: recordsArb,
  policyRev: policyRevArb,
}).map(x => {
  const e = table[x.operation]
  const scope = SCOPE[x.operation]
  return { ...x, accountId: ACCOUNT[x.operation], scope, scopeKey: scopeKey(scope), units: 1, effects: { ...e.effects }, memberMay: e.memberMay, args: {}, payloadHash: '0'.repeat(64) }
})
const caseArb = tableArb.chain(table => fc.tuple(resolvedArb(table), ctxArb(ASKER, false)).chain(([r, ctx]) => ceilingsArb(r.operation).chain(ceilings => fc.record({
  table: fc.constant(table),
  r: fc.constant(r),
  ctx: fc.constant(ctx as DecideCtx & { asker: Asker }),
  ceilings: fc.constant(ceilings),
  grants: fc.integer({ min: 0, max: 4 }).chain(n => fc.tuple(...Array.from({ length: n }, (_, i) => grantArb(r, ceilings, ctx.asker, i, { other: OTHER })))),
}))))

async function writeState(c: { r: Resolved; ctx: DecideCtx & { asker: Asker }; ceilings: DecideFacts['ceiling']; grants: GrantFacts[] }): Promise<void> {
  await resetPermissions(db)
  await person(db, ASKER, c.ctx.asker.role)
  await person(db, OTHER, 'admin')
  for (const op of OPS) if (c.ceilings[op]) await ceiling(db, op, c.ceilings[op]!)
  await account(db, c.r.accountId, c.r.accountGen)
  await channel(db, CHANNEL, 'claims', OTHER)
  for (const g of c.grants) await insertGrant(db, g)
}

const useFor = (actionId: string, grantId: string) =>
  db.prepare("INSERT INTO permission_uses (id, action_id, action_rev, grant_id, day, units, at_ms) VALUES (? || '#1', ?, 1, ?, '2026-11-26', 1, 1)").bind(actionId, actionId, grantId).run()

beforeEach(() => resetPermissions(db))

describe('claimGuardSql agrees with decideCore', () => {
  it('D1: a grant-backed row passes exactly when decideCore, given that grant, runs with it', async () => {
    const tally: string[] = []
    await fc.assert(fc.asyncProperty(caseArb, async raw => {
      const c = { ...raw, grants: storable(raw.grants) }
      await writeState(c)
      for (const [i, g] of c.grants.entries()) {
        const id = `ac_claim_${i}`
        await useFor(id, g.id)
        const v = decideCore({ ceiling: c.ceilings, grants: [g], allowOnceCount: 0 }, c.ctx, c.r)
        const want = v.verdict === 'run' && v.grantId === g.id
        const got = await passes(rowOf(c.r, c.ctx, { id, verdict: 'run', grant_id: g.id, approved_by: `grant:${g.id}` }), c.table)
        tally.push(`${want}/${got}`)
        expect(got).toBe(want)
      }
    }), { numRuns: 150 })
    // The generator draws both answers (a property that only ever sees `false` proves nothing).
    expect(tally).toContain('true/true')
    expect(tally).toContain('false/false')
  })

  it('D2: a person-approved row passes exactly when decideCore doesn\'t refuse and its policy is current', async () => {
    const tally: string[] = []
    await fc.assert(fc.asyncProperty(caseArb, async raw => {
      const c = { ...raw, grants: storable(raw.grants) }
      await writeState(c)
      const v = decideCore({ ceiling: c.ceilings, grants: c.grants, allowOnceCount: 0 }, c.ctx, c.r)
      const want = v.verdict !== 'refuse' && c.r.policyRev === POLICY_REV
      const verdict = v.verdict === 'refuse' ? 'ask' : v.verdict === 'run' ? 'ask' : v.verdict
      const got = await passes(rowOf(c.r, c.ctx, { verdict }), c.table)
      tally.push(`${want}/${got}`)
      expect(got).toBe(want)
    }), { numRuns: 150 })
    expect(tally).toContain('true/true')
    expect(tally).toContain('false/false')
  })
})

describe('the claim\'s own checks (D3)', () => {
  const r: Resolved = {
    operation: 'slack.channel.post', args: {}, accountId: 'slack:workspace', accountGen: 2_000, scope: { channelId: CHANNEL },
    scopeKey: `channelId=${CHANNEL}`, records: 1, units: 1, effects: { money: false, customer: false, destructive: false, access: false },
    memberMay: true, payloadHash: '0'.repeat(64), policyRev: POLICY_REV,
  }
  const ctx = { asker: { memberId: ASKER, role: 'member' as const }, origin: 'chat' as const, chatId: 'c_claim', nowMs: 10 }
  const grant: GrantFacts = {
    id: 'pg_claimUnitAAAAAAAAAAAAAA', holder: `member:${ASKER}`, accountId: r.accountId, accountGen: r.accountGen, operation: r.operation,
    scopeKey: r.scopeKey, perDay: 5, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  }
  const runRow = rowOf(r, ctx, { verdict: 'run', grant_id: grant.id, approved_by: `grant:${grant.id}` })
  const personRow = rowOf(r, ctx, {})
  beforeEach(async () => {
    await writeState({ r, ctx, ceilings: { 'slack.channel.post': { enabled: true, perDayMax: 5, loweredRev: 1 } }, grants: [grant] })
    await useFor(runRow.id, grant.id)
  })

  it('passes both rows as set up', async () => {
    expect(await passes(runRow)).toBe(true)
    expect(await passes(personRow)).toBe(true)
  })

  it('fails once the asker is removed', async () => {
    await person(db, ASKER, 'member', 'removed')
    expect(await passes(runRow)).toBe(false)
    expect(await passes(personRow)).toBe(false)
  })

  it('fails once the account is reconnected (a new generation) or disconnected', async () => {
    await account(db, r.accountId, r.accountGen + 1)
    expect(await passes(runRow)).toBe(false)
    expect(await passes(personRow)).toBe(false)
    await account(db, r.accountId, r.accountGen)
    await db.prepare('UPDATE connector_accounts SET disconnected_at_ms = ? WHERE account_id = ?').bind(r.accountGen + 5, r.accountId).run()
    expect(await passes(personRow)).toBe(false)
  })

  it('fails once the channel is no longer listed', async () => {
    await db.prepare('UPDATE notify_channels SET removed_at_ms = 5, removed_by = ? WHERE channel_id = ?').bind(OTHER, CHANNEL).run()
    expect(await passes(runRow)).toBe(false)
    expect(await passes(personRow)).toBe(false)
  })

  it('fails a grant-backed row whose use is released or missing, or that is a routine\'s', async () => {
    expect(await passes({ ...runRow, id: 'ac_claim_nouse' })).toBe(false)
    expect(await passes({ ...runRow, rev: 2 })).toBe(false)
    expect(await passes({ ...runRow, origin: 'routine' })).toBe(false)
    await db.prepare("UPDATE permission_uses SET released_at_ms = 5, release_reason = 'undone' WHERE action_id = ?").bind(runRow.id).run()
    expect(await passes(runRow)).toBe(false)
  })

  it('fails a person-approved row whose approver is gone or isn\'t a member at all', async () => {
    expect(await passes({ ...personRow, approved_by: 'm_nobody' })).toBe(false)
    expect(await passes({ ...personRow, approved_by: null })).toBe(false)
  })
})
