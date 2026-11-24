// P8a F2's health signals.
// - `privacy_requests`: amber (ok, so it never blocks a deploy, a rollback or the release smoke) while any Shopify privacy
//   request is open, and red once the oldest has `RED_DAYS` or fewer days left before Shopify's 30-day limit (or is past
//   it). A monitor that reads the signals raises both. Counts only: how many are open, how many couldn't be parsed, and
//   the whole days left on the oldest (negative once past it).
// - `shopify_webhook_secrets`: red when SHOPIFY_WEBHOOK_SECRETS is set but doesn't parse (every delivery then answers
//   503), amber when unset (a deployment with no Shopify app, the eval and sandbox ones; a brand release can't deploy
//   without it, since it's in `secrets.required`).
import type { Signal, SignalResult } from '../../ops/signals/types.ts'
import { webhookSecrets } from './handler.ts'
import type { PrivacyRequestStore } from './store.ts'

const DAY = 86_400_000
/** Red from this many days left. */
export const RED_DAYS = 7

export async function privacySignal(store: Pick<PrivacyRequestStore, 'open'>, nowMs: number): Promise<SignalResult> {
  const open = await store.open()
  if (open.length === 0) return { ok: true }
  const soonest = Math.min(...open.map(r => r.due_at_ms)) - nowMs
  const left = Math.floor(soonest / DAY)
  const unparsed = open.filter(r => r.parse_failed === 1).length
  const detail = `${open.length} open${unparsed > 0 ? ` (${unparsed} unparsed)` : ''}, oldest ${left} days left`
  return soonest <= RED_DAYS * DAY ? { ok: false, detail } : { ok: true, amber: true, detail }
}

export function secretsSignal(raw: unknown): SignalResult {
  if (raw === undefined) return { ok: true, amber: true, detail: 'not set' }
  const secrets = webhookSecrets(raw)
  return secrets ? { ok: true, detail: `${secrets.length} app secrets` } : { ok: false, detail: 'malformed' }
}

export function privacyHealth(now: () => number = () => Date.now()): Signal {
  return { name: 'privacy_requests', check: ({ stores }) => privacySignal(stores.privacyRequests, now()) }
}

export const privacySignals: readonly Signal[] = [
  privacyHealth(),
  { name: 'shopify_webhook_secrets', check: async ({ env }) => secretsSignal((env as { SHOPIFY_WEBHOOK_SECRETS?: unknown }).SHOPIFY_WEBHOOK_SECRETS) },
]
