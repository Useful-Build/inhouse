// What notification_send needs beyond the database: the hub's delivery binding (P5 W4; B2, 2026-11-21). The egress
// wires the inhouse MCP server, so it builds this with `notifyDeps(env)` and passes it on without looking inside: the
// egress imports only this factory, never app/server/notify-slack/** or the hub's contract types (a lint rule checks).
// What keeps the runner off HUB_DELIVERY is code discipline plus checks, not config structure (p5-w4.md section 1).
import type { DeliveryBinding } from '../../../notify-slack/send.ts'

declare const opaque: unique symbol

/** Opaque outside this folder: built only by `notifyDeps`, read only by the notifications tool. */
export type NotifyDeps = { readonly [opaque]: true }

type Inside = { delivery: DeliveryBinding | null }

export function notifyDeps(env: { HUB_DELIVERY?: unknown }): NotifyDeps {
  const inside: Inside = { delivery: (env.HUB_DELIVERY as DeliveryBinding | undefined) ?? null }
  return inside as unknown as NotifyDeps
}

/** The binding inside, or null (no deps at all: channels answer slack_unavailable, the bell still works). */
export const deliveryOf = (deps: NotifyDeps | undefined): DeliveryBinding | null => (deps ? (deps as unknown as Inside).delivery : null)
