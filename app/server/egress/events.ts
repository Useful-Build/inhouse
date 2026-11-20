// The events route (p3-design 8.6, the push model of section 1): `POST /events/` `{ turnId, events }` (protocol v2
// `PushBatch`) from the root runner with the turn's token. The batch must be the grant's turn; then the BrandAgent
// ingests it and the Runner is touched (an incoming request that keeps it and its container active). The answer is the
// BrandAgent's `{ ackSeq, stop }`, or 410 once the turn has ended (the runner drops the batch).
import { PUSH_BATCH_MAX_BYTES, PushBatch } from '../../shared/protocol/index.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import type { EgressDeps } from './deps.ts'
import { jsonAnswer, parseJson, readCapped } from './http.ts'

export async function eventsRoute(request: Request, path: string, grant: RunGrant, d: EgressDeps): Promise<Response> {
  if (path !== '/events/') return jsonAnswer({ error: 'not_found' }, 404)
  if (request.method !== 'POST') return jsonAnswer({ error: 'method' }, 405)
  const bytes = await readCapped(request, PUSH_BATCH_MAX_BYTES)
  if (bytes === null) return jsonAnswer({ error: 'too_large' }, 413)
  const batch = PushBatch.safeParse(parseJson(bytes))
  if (!batch.success) return jsonAnswer({ error: 'invalid' }, 400)
  if (batch.data.turnId !== grant.turnId) return jsonAnswer({ error: 'scope' }, 403)
  const ack = await d.rpc.ingest(grant.turnId, batch.data.events)
  if ('gone' in ack) return jsonAnswer({ error: 'gone' }, 410)
  try {
    await d.touchRunner(d.runner)
  } catch (e) {
    // The batch is stored; the next push touches again. Logged without ids.
    d.log({ event: 'egress_touch_failed', route: 'events', error: e instanceof Error ? e.name : 'unknown' })
  }
  return jsonAnswer(ack)
}
