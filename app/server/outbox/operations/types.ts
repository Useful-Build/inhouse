// Stage 1 M2 (frozen by W0-A; M2-A fills the table, N9): one entry per write operation. The server types its table as
// `OperationTable` (each entry typed by its own key), so it and the hub's `WRITE_OPERATIONS` can't drift. Types only.
import type { z } from 'zod'
import type { WriteOperationKey } from '../../../hub/index/contract.ts'
import type { ResolveFacts } from '../../permissions/types.ts'

export type { WriteOperationKey }

/** What an operation can do beyond its own record. Any flag set means an exact approval (N9). */
export interface Effects { money: boolean; customer: boolean; destructive: boolean; access: boolean }

export interface OperationEntry<A = unknown> {
  key: WriteOperationKey
  /** The tool name the agent calls: 'shopify_order_tag_add', 'slack_channel_post'. */
  tool: string
  /** What the actions server lists. */
  description: string
  /** Strict. */
  args: z.ZodType<A>
  connector: 'shopify' | 'slack'
  scope(a: A, f: ResolveFacts): Record<string, string> | { refuse: 'not_listed' }
  records(a: A): number
  units(a: A): number
  effects: Effects
  memberMay: boolean
  reversible: boolean
  /** M2: no automatic resend. */
  idempotent: false
  /** 50. */
  defaultPerDay: number
  /** Server words only. */
  card(a: A, f: ResolveFacts): { title: string; lines: string[] }
}

/** One entry per operation, each under its own key (`entry.key` is its record key). */
export type OperationTable = { readonly [K in WriteOperationKey]: OperationEntry & { key: K } }
