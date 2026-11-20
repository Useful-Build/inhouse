// Support grants, for the real targets. The seed has none; a case that leaves one live is undone here.
import type { Signer } from './me'

/** Ends a live grant, as an Admin. */
export async function endLiveGrant(s: Signer, as: 'admin' | 'dana' | 'leo' = 'admin'): Promise<void> {
  const r = await s.api(as, 'GET', '/api/grants')
  if (r.status !== 200) throw new Error(`The real contract target couldn't read the grants: ${r.status}`)
  for (const g of r.json.items as { id: string; live: boolean; rev: number }[]) {
    if (!g.live) continue
    const done = await s.api(as, 'POST', `/api/grants/${g.id}/end`, { ifRev: g.rev })
    if (done.status >= 300 && done.status !== 404) throw new Error(`The real contract target couldn't end a grant: ${done.status}`)
  }
}

/**
 * A grant's `rev` moves only when it ends, so nothing a second session does makes a live grant's rev stale. The target
 * therefore makes the client's own end request stale on the wire (the rev it sent, plus a thousand): the server sees what
 * it would see from a client that last read an older record, and answers `conflict` with the grant as it is.
 */
export const staleRev = (body: unknown): unknown => {
  const b = body as { ifRev?: number }
  return typeof b?.ifRev === 'number' ? { ...b, ifRev: b.ifRev + 1000 } : body
}
