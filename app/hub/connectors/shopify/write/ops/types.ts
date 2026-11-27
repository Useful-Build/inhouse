// One Shopify write operation as the hub runs it (Stage 1 M3-S1, N21): its strict arguments, the scope its mutation
// needs, the one mutation document it sends and how it reads Shopify's answer. The shared core (`../core.ts`) runs
// every account, store and scope check before and right before the send; an operation only builds and reads.
import type { z } from 'zod'
import type { WriteOperationKey, WriteResult } from '../../../../index/contract'
import type { MutationDoc, ShopifyWriteScope } from '../provider'

/** The hub's Shopify writes: every operation key under `shopify.`. */
export type ShopifyWriteKey = Extract<WriteOperationKey, `shopify.${string}`>

export interface ShopifyWriteOp<A> {
  key: ShopifyWriteKey
  /** The scope the mutation needs; the core refuses `scope_mismatch` before the send when the token lacks it. */
  scope: ShopifyWriteScope
  /** Strict: anything outside it is `invalid_args`, `sent: 'no'`, before any upstream call. */
  args: z.ZodType<A>
  /** The one mutation document this call sends (one upstream request per hub call). */
  document(a: A): MutationDoc
  /** Reads a 200's `data` into the answer: `sent: 'no'` only when nothing in the document ran. */
  read(data: Record<string, unknown>, a: A): WriteResult
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

/** An operation with its argument type closed over, so the table holds every operation under one type. */
export interface PreparedShopifyWriteOp {
  key: ShopifyWriteKey
  scope: ShopifyWriteScope
  /** Parses the arguments strictly: the document to send and how to read its answer, or the first bad path. */
  prepare(args: unknown): { ok: true; doc: MutationDoc; read(data: Record<string, unknown>): WriteResult } | { ok: false; path: string }
}

export function prepared<A>(op: ShopifyWriteOp<A>): PreparedShopifyWriteOp {
  return {
    key: op.key,
    scope: op.scope,
    prepare(args) {
      const parsed = op.args.safeParse(args)
      if (!parsed.success) return { ok: false, path: parsed.error.issues[0]?.path.join('.') || 'args' }
      const a = parsed.data
      return { ok: true, doc: op.document(a), read: data => op.read(data, a) }
    },
  }
}
