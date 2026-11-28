// `resolve` (N9): a proposal (an operation and the model's raw arguments) becomes a `Resolved`, or a refusal. The model
// supplies only the operation and the arguments; the server derives everything else. The account and its generation
// come from the brand's connected account (`connector_accounts.connected_at_ms`), never from the arguments; the scope,
// the counts, the effects and `memberMay` from the operation's entry. Pure; async only for WebCrypto's digest.
import { auditInputSha256 } from '../../shared/protocol/index.ts'
import { operationEntry } from '../outbox/operations/index.ts'
import { POLICY_REV } from './policy.ts'
import type { RefuseReason, RefuseVerdict, ResolveFn } from './types.ts'

const refuse = (reason: RefuseReason): { refuse: RefuseVerdict } => ({ refuse: { verdict: 'refuse', reason } })

/** A scope as one key: its entries sorted by name, `name=value` joined by `&`, each part URI-encoded. */
export function scopeKeyOf(scope: Readonly<Record<string, string>>): string {
  return Object.keys(scope).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(scope[k])}`).join('&')
}

/**
 * SHA-256 of the canonical JSON of what the action would do: operation, account, generation, scope and parsed
 * arguments. The same canonical form and hash the runner and the egress use (`auditInputSha256`), lower-case hex.
 */
export function payloadHashOf(p: { operation: string; accountId: string; accountGen: number; scope: Readonly<Record<string, string>>; args: unknown }): Promise<string> {
  return auditInputSha256({ operation: p.operation, accountId: p.accountId, accountGen: p.accountGen, scope: p.scope, args: p.args })
}

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 1

export const resolve: ResolveFn = async (f, p) => {
  // The key may come from outside (a cast tool name, a stored row): look it up, never index blindly.
  const entry = typeof p.operation === 'string' ? operationEntry(p.operation) : null
  if (!entry) return refuse('unknown_operation')
  const parsed = entry.args.safeParse(p.args)
  if (!parsed.success) return refuse('invalid_args')
  const args = parsed.data
  // Stage 1 M4 (N46): an MCP write resolves from `f.connections` (M4-W2 builds it with its operation entry). No entry
  // writes to a connection before then, so reaching here is a bug in the table: fail loud.
  if (entry.connector === 'mcp') throw new Error(`resolve: ${entry.key} writes to a connection, which M4-W2 resolves`)
  const account = f.accounts[entry.connector]
  if (!account || !account.connected || account.paused || account.connectedAtMs === null) return refuse('account_unavailable')
  if (entry.connector === 'shopify' && !account.shop) return refuse('account_unavailable')
  const scope = entry.scope(args, f)
  // An entry's scope refuses a target the brand didn't list, or (Stage 1 M3-S2) an argument or account fact the brand's
  // account can't take: a refund in another currency than the shop's, or while the shop's currency isn't known.
  if ('refuse' in scope) {
    const reason = scope.refuse
    if (reason === 'not_listed' || reason === 'invalid_args' || reason === 'account_unavailable') return refuse(reason)
    throw new Error(`resolve: ${entry.key} refused with a reason no entry may give`)
  }
  const records = entry.records(args)
  const units = entry.units(args)
  // An entry that counts nothing, or a fraction, is a bug in the table: fail loud rather than let it past the guardrails.
  if (!isCount(records) || !isCount(units)) throw new Error(`resolve: ${entry.key} counted ${records} records, ${units} units`)
  const accountGen = account.connectedAtMs
  return {
    operation: entry.key,
    args,
    accountId: account.accountId,
    accountGen,
    scope,
    scopeKey: scopeKeyOf(scope),
    records,
    units,
    effects: { ...entry.effects },
    memberMay: entry.memberMay,
    payloadHash: await payloadHashOf({ operation: entry.key, accountId: account.accountId, accountGen, scope, args }),
    policyRev: POLICY_REV,
  }
}
