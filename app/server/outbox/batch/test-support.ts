// Helpers for the batch tests (server/outbox/batch/*.test.ts, in the Workers runtime). Never imported by the Worker.
import { z } from 'zod'
import type { WriteGateway, WriteRequest, WriteResult } from '../../../hub/index/contract.ts'
import { sendAction } from '../dispatch.ts'
import type { DispatchDeps } from '../dispatch.ts'
import { OPERATIONS } from '../operations/index.ts'
import type { OperationEntry } from '../operations/types.ts'
import { fresh, notices } from '../test-support.ts'
import type { OutboxActionRow, OutboxItemRow } from '../types.ts'

/** How the fake hub answers one item's call. `hang`: never, until released. */
export type ItemMode = 'ok' | 'no' | 'throttle' | 'unknown' | 'throw' | 'hang'

export interface ItemCall { req: WriteRequest; violation: string | null; ran: boolean }

/**
 * A fake WriteGateway for batch items. Every call is recorded; at call time it reads the item and its batch and records
 * a violation when the call didn't follow a winning item claim at this attempt (the item `sending`, its batch `sending`,
 * its position within the approval), or a grant-backed batch has no live use. `ran`: the upstream did something (a
 * throttled call ran nothing).
 */
export function itemHub(db: D1Database, next: (req: WriteRequest) => ItemMode) {
  const calls: ItemCall[] = []
  const hanging: ((r: WriteResult) => void)[] = []
  const gateway: WriteGateway = {
    async runAction(req) {
      const mode = next(req)
      const call: ItemCall = { req, violation: null, ran: mode !== 'throttle' && mode !== 'no' }
      calls.push(call)
      const batch = await db.prepare('SELECT * FROM outbox_actions WHERE id = ?').bind(req.actionId).first<OutboxActionRow>()
      const item = req.item
        ? await db.prepare('SELECT * FROM outbox_items WHERE action_id = ? AND n = ?').bind(req.actionId, req.item.n).first<OutboxItemRow>()
        : null
      if (!batch || !item || !req.item) call.violation = 'a call for no batch item'
      else if (batch.state !== 'sending') call.violation = `a call while the batch is ${batch.state}`
      else if (item.state !== 'sending' || item.attempt !== req.attempt) call.violation = `a call without a winning item claim (${item.state}, attempt ${item.attempt} vs ${req.attempt})`
      else if (batch.approved_upto === null || item.n > batch.approved_upto) call.violation = `a call past the approval (${item.n} of ${batch.approved_upto})`
      else if (req.requestId !== `${batch.id}:${item.n}` || req.idempotencyKey !== `${batch.id}:${item.n}` || req.item.of !== batch.approved_upto) call.violation = 'a call with the wrong ids'
      else if (batch.grant_id !== null) {
        const use = await db.prepare('SELECT 1 AS one FROM permission_uses WHERE id = ? AND grant_id = ? AND released_at_ms IS NULL')
          .bind(`${batch.id}#${batch.approved_rev}`, batch.grant_id).first()
        if (!use) call.violation = 'a grant-backed call with no live use'
      }
      switch (mode) {
        case 'ok': return { ok: true, value: { ref: `done-${req.item?.n ?? 0}` } }
        case 'no': return { ok: false, error: { code: 'upstream_rejected', message: 'refused' }, sent: 'no' }
        case 'throttle': return { ok: false, error: { code: 'rate_limited', message: 'throttled', retryAfterMs: 1_500 }, sent: 'no' }
        case 'unknown': return { ok: false, error: { code: 'upstream_unavailable', message: 'unclear' }, sent: 'unknown' }
        case 'throw': throw new Error('binding broke')
        case 'hang': return new Promise<WriteResult>(r => { hanging.push(r) })
      }
    },
  }
  return { gateway, calls, release: (r: WriteResult) => { for (const h of hanging.splice(0)) h(r) } }
}

/** One pass of a batch's send task at `nowMs`, its re-runs recorded. */
export async function pass(db: D1Database, actionId: string, o: Partial<DispatchDeps> & { nowMs: number; hub: WriteGateway | null }) {
  const again: number[] = []
  const note = notices()
  const outcome = await sendAction(actionId, {
    db, notify: note.notify, requestId: fresh('send'), again: at => { again.push(at) }, gate: { paused: false, pauseGen: 0 }, timeoutMs: 1_000, ...o,
  })
  return { outcome, again, notices: note.list }
}

export const itemsOf = async (db: D1Database, actionId: string) =>
  (await db.prepare('SELECT * FROM outbox_items WHERE action_id = ? ORDER BY n').bind(actionId).all<OutboxItemRow>()).results

/** `shopify.order.tag_add`'s arguments as M3-S1 widens them: 1 to 100 orders, each its own item. */
const WideArgs = z.strictObject({ orderIds: z.array(z.string().regex(/^gid:\/\/shopify\/Order\/[1-9][0-9]{0,19}$/)).min(1).max(100), tags: z.array(z.string().min(1).max(40)).min(1).max(5) })
type Wide = z.infer<typeof WideArgs>

export const wideArgs = (orders: readonly number[], tag = 'vip'): Wide => ({ orderIds: orders.map(o => `gid://shopify/Order/${o}`), tags: [tag] })

/**
 * Swaps `shopify.order.tag_add` for the shape M3-S1 gives it (a list of orders, one item each), so a call over the bulk
 * threshold or a multi-record run makes its own batch. Returns the undo. Tests only: the table is otherwise fixed.
 */
export function widenTagAdd(): () => void {
  const table = OPERATIONS as unknown as Record<string, OperationEntry>
  const was = table['shopify.order.tag_add']!
  const wide: OperationEntry<Wide> = {
    ...(was as unknown as OperationEntry<Wide>),
    args: WideArgs,
    records: a => a.orderIds.length,
    units: a => a.orderIds.length,
    items: a => a.orderIds.map(id => ({ orderIds: [id], tags: a.tags })),
    itemLine: (a, f) => `Orders ${a.orderIds.map(o => o.slice(o.lastIndexOf('/') + 1)).join(', ')} (${f.accounts.shopify?.shop ?? ''}): add ${a.tags.join(', ')}`,
    card: a => ({ title: `Add ${a.tags.join(', ')} to ${a.orderIds.length} orders`, lines: a.tags.map(t => `Tag: ${t}`) }),
  }
  table['shopify.order.tag_add'] = wide as unknown as OperationEntry
  return () => { table['shopify.order.tag_add'] = was }
}

/** `db`, calling `then` once its `n`-th call (a statement's run, first or all, or a batch) settles. */
export function afterNthCall(db: D1Database, n: number, then: () => Promise<void> | void): D1Database {
  let calls = 0
  const tick = async () => {
    if (++calls === n) await then()
  }
  const real = new WeakMap<object, D1PreparedStatement>()
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(st, {
      get(target, key) {
        if (key === 'bind') return (...v: unknown[]) => wrap(target.bind(...v))
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') {
          return async (...a: unknown[]) => {
            const r = await (target[key] as (...x: unknown[]) => Promise<unknown>).apply(target, a)
            await tick()
            return r
          }
        }
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v
      },
    })
    real.set(proxy, st)
    return proxy
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      if (key === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const r = await target.batch(stmts.map(x => real.get(x) ?? x))
          await tick()
          return r
        }
      }
      const v = Reflect.get(target, key) as unknown
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v
    },
  })
}
