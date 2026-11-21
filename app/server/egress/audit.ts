// The audit route (p3-design 8.7, a durable audit ACK): `POST /audit/` `{ turnId, n, entry }` (protocol v2 `AuditPost`)
// from the root runner. The BrandAgent writes the redacted `tool_calls` row (W1's table, keyed `(turn_id, n)`, never
// the input), then 204. The root acks the session's hook only on this 204; anything else denies the call.
import { AuditPost } from '../../shared/protocol/index.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import type { EgressDeps } from './deps.ts'
import { jsonAnswer, parseJson, readCapped, scopeRefused } from './http.ts'

/** An entry's input is capped at 16 KB as JSON (`AUDIT_INPUT_MAX_BYTES`); the rest of the post is small. */
export const AUDIT_BODY_MAX_BYTES = 64 * 1024

export async function auditRoute(request: Request, path: string, grant: RunGrant, d: EgressDeps): Promise<Response> {
  if (path !== '/audit/') return jsonAnswer({ error: 'not_found' }, 404)
  if (request.method !== 'POST') return jsonAnswer({ error: 'method' }, 405)
  const bytes = await readCapped(request, AUDIT_BODY_MAX_BYTES)
  if (bytes === null) return jsonAnswer({ error: 'too_large' }, 413)
  const post = AuditPost.safeParse(parseJson(bytes))
  if (!post.success) return jsonAnswer({ error: 'invalid' }, 400)
  if (post.data.turnId !== grant.turnId) return scopeRefused('audit', d)
  await d.rpc.writeToolCall(grant.turnId, post.data.n, post.data.entry)
  return new Response(null, { status: 204 })
}
