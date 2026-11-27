// One Shopify write operation as the hub runs it (Stage 1 M3-S1, N21): its strict arguments, the scope its mutation
// needs, the one mutation document it sends and how it reads Shopify's answer. The shared core (`../core.ts`) runs
// every account, store and scope check before and right before the send; an operation only builds and reads.
//
// Stage 1 M3-S2 (N21): an operation may also
// - take an idempotency key (`idempotent`): its mutation carries `@idempotent(key: $idempotencyKey)` and the core refuses
//   a call without one (`invalid_args`, `sent: 'no'`), so a person's later "try again" can't apply twice;
// - read first (`lookup`): one query before the mutation (a refund's suggested amount). Nothing in a query changes the
//   store, so every way the lookup fails is `sent: 'no'`; its answer can refuse the write (`sent: 'no'`) or shape it.
import type { z } from 'zod'
import type { WriteOperationKey, WriteResult } from '../../../../index/contract'
import type { MutationDoc, ShopifyWriteScope } from '../provider'

/** The hub's Shopify writes: every operation key under `shopify.`. */
export type ShopifyWriteKey = Extract<WriteOperationKey, `shopify.${string}`>

/** A lookup's verdict: the facts the mutation is built from, or a finished refusal (always `sent: 'no'`). */
export type LookupVerdict<L> = { ok: true; value: L } | { ok: false; result: WriteResult & { ok: false; sent: 'no' } }

export interface ShopifyWriteOp<A, L = undefined> {
  key: ShopifyWriteKey
  /** The scope the mutation needs; the core refuses `scope_mismatch` before the send when the token lacks it. */
  scope: ShopifyWriteScope
  /** Strict: anything outside it is `invalid_args`, `sent: 'no'`, before any upstream call. */
  args: z.ZodType<A>
  /** The mutation takes an idempotency key (`@idempotent`); a call without one is refused before any request. */
  idempotent: boolean
  /** A query sent before the mutation, and what its `data` says: go ahead with these facts, or refuse. */
  lookup?: { document(a: A): MutationDoc; decide(data: Record<string, unknown>, a: A): LookupVerdict<L> }
  /** The one mutation document this call sends (one upstream write request per hub call). */
  document(a: A, ctx: { idempotencyKey: string | undefined; looked: L }): MutationDoc
  /** Reads a 200's `data` into the answer: `sent: 'no'` only when nothing in the document ran. */
  read(data: Record<string, unknown>, a: A, looked: L): WriteResult
}

/** How one root field of the document came back. */
export type RootOutcome = 'done' | 'refused' | 'unclear'

/**
 * One root field's payload: `done` when it has no user errors and `isDone(payload)`; `refused` when it has user errors and
 * no result object (Shopify refused that mutation, nothing changed); anything else is `unclear`.
 */
export function rootOutcome(payload: unknown, resultKey: string, isDone: (result: unknown) => boolean): RootOutcome {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 'unclear'
  const p = payload as Record<string, unknown>
  if (!Array.isArray(p.userErrors)) return 'unclear'
  if (p.userErrors.length > 0) return p[resultKey] === null || p[resultKey] === undefined ? 'refused' : 'unclear'
  return isDone(p[resultKey]) ? 'done' : 'unclear'
}

/** The mutation step of a prepared call: built from the lookup's data (null when the operation has no lookup). */
export type MutationStep = { ok: true; doc: MutationDoc; read(data: Record<string, unknown>): WriteResult } | { ok: false; result: WriteResult & { ok: false; sent: 'no' } }

/** A call whose arguments passed: an optional lookup query, then the mutation built from its answer. */
export type PreparedCall = { lookup: MutationDoc | null; mutation(lookupData: Record<string, unknown> | null): MutationStep }

/** An operation with its argument type closed over, so the table holds every operation under one type. */
export interface PreparedShopifyWriteOp {
  key: ShopifyWriteKey
  scope: ShopifyWriteScope
  idempotent: boolean
  /** Parses the arguments strictly: the call's steps, or the first bad path. */
  prepare(args: unknown, idempotencyKey: string | undefined): { ok: true; call: PreparedCall } | { ok: false; path: string }
}

export function prepared<A, L>(op: ShopifyWriteOp<A, L>): PreparedShopifyWriteOp {
  return {
    key: op.key,
    scope: op.scope,
    idempotent: op.idempotent,
    prepare(args, idempotencyKey) {
      if (op.idempotent && idempotencyKey === undefined) return { ok: false, path: 'idempotencyKey' }
      const parsed = op.args.safeParse(args)
      if (!parsed.success) return { ok: false, path: parsed.error.issues[0]?.path.join('.') || 'args' }
      const a = parsed.data
      const build = (looked: L): MutationStep => ({ ok: true, doc: op.document(a, { idempotencyKey, looked }), read: data => op.read(data, a, looked) })
      const lookup = op.lookup
      if (!lookup) return { ok: true, call: { lookup: null, mutation: () => build(undefined as L) } }
      return {
        ok: true,
        call: {
          lookup: lookup.document(a),
          mutation: data => {
            // The core sends the mutation only after a lookup answered with data.
            if (data === null) throw new Error(`${op.key}: the mutation was built with no lookup answer`)
            const v = lookup.decide(data, a)
            return v.ok ? build(v.value) : v
          },
        },
      }
    },
  }
}
