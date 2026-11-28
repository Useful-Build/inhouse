// M4's fixture MCP servers, login server and REST API, behind one fetch (Stage 1 M4-F, N52). The hub's test seam
// (app/hub/testing/index.ts) registers `mcpFixtures.fetch` for every host in MCP_FIXTURE_HOSTS; the eval hub is the same
// test bundle, so the fixtures are there too. Bundled into the hub's TEST build only: relative imports and runtime
// globals, no npm package. Never deployed: scripts/check-hub-build.mjs fails a deployable bundle carrying
// MCP_FIXTURES_CANARY or any module under app/test/upstreams/.
//
// Which file stands for which spec page: modern.ts (2026-07-28), legacy.ts (2025-11-25), helpdesk.ts (a Gorgias-shaped
// 2026-07-28 server), as.ts (the login server, E1 to E12, F1 to F4), detect.ts (the six addresses), vectors.ts (raw
// requests for the differential test), ../rest/server.ts (Path C).

import { FixtureLoginServer } from './as'
import { blockedFetch, privateTrapFetch, redirectFetch } from './detect'
import { createHelpdeskServer, HELPDESK_KEY } from './helpdesk'
import { LegacyMcpServer } from './legacy'
import { createModernServer, MODERN_KEY } from './modern'
import { FakeRestApi, REST_KEY } from '../rest/server'
import { credentialOf, HOSTS, isObject, WireLog } from './wire'

/** Found in the hub's test bundle only (the bundle scan reads it from here). */
export const MCP_FIXTURES_CANARY = 'INHOUSE_MCP_FIXTURES_CANARY_61a9'

export const MCP_FIXTURE_HOSTS: readonly string[] = Object.values(HOSTS)

/** The keys a test may revoke, by name (the hook's `revokeKey`). */
export const FIXTURE_KEYS = { modern: MODERN_KEY, helpdesk: HELPDESK_KEY, rest: REST_KEY } as const
export type FixtureKeyName = keyof typeof FIXTURE_KEYS

export function createMcpFixtures(opts: { now?: () => number } = {}) {
  const log = new WireLog()
  const revokedKeys = new Set<string>()
  const as = new FixtureLoginServer(opts)
  const modern = createModernServer(as, revokedKeys)
  const legacy = new LegacyMcpServer(as)
  const helpdesk = createHelpdeskServer(as, revokedKeys)
  const rest = new FakeRestApi()

  const route = (host: string): ((req: Request) => Promise<Response>) | null => {
    switch (host) {
      case HOSTS.modern:
        return modern.fetch
      case HOSTS.legacy:
        return legacy.fetch
      case HOSTS.helpdesk:
        return helpdesk.fetch
      case HOSTS.login:
        return as.fetch
      case HOSTS.blocked:
        return blockedFetch
      case HOSTS.redirect:
        return redirectFetch
      case HOSTS.rest:
        return rest.fetch
      case HOSTS.privateTrap:
        return privateTrapFetch
      default:
        return null
    }
  }

  /** One request to any fixture host, logged (method, path, credential kind, JSON-RPC method, tool and arguments). */
  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const entry = log.add({ host: url.host, path: url.pathname, method: req.method, credential: credentialOf(req) })
    if (req.method === 'POST' && (req.headers.get('Content-Type') ?? '').includes('json')) {
      const body = await req.clone().json().catch(() => null)
      if (isObject(body) && typeof body.method === 'string') {
        entry.rpc = body.method
        const params = isObject(body.params) ? body.params : {}
        if (body.method === 'tools/call' && typeof params.name === 'string') {
          entry.tool = params.name
          entry.args = isObject(params.arguments) ? structuredClone(params.arguments) : {}
        }
      }
    }
    const handler = route(url.host)
    const res = handler ? await handler(req) : new Response(`no fixture for host "${url.host}" (${MCP_FIXTURES_CANARY})`, { status: 599 })
    entry.status = res.status
    const location = res.headers.get('Location')
    if (location !== null) entry.location = location
    return res
  }

  return {
    fetch,
    log,
    as,
    modern,
    legacy,
    helpdesk,
    rest,
    revokedKeys,
    /** Revokes one fixture key: every later request carrying it is refused. */
    revokeKey(name: FixtureKeyName): void {
      if (name === 'rest') rest.revokeKey()
      else revokedKeys.add(FIXTURE_KEYS[name])
    },
    /** Logs, sessions, tokens, counters, revoked keys: all back to a fresh fixture's. */
    reset(): void {
      log.clear()
      revokedKeys.clear()
      as.reset()
      modern.reset()
      legacy.reset()
      helpdesk.reset()
      rest.reset()
    },
    /** A JSON copy of what the fixtures saw (for the test-fakes hook's `state`). */
    state() {
      return JSON.parse(JSON.stringify({
        log: log.entries,
        modern: { calls: modern.calls, writes: modern.writes, violations: modern.violations, streamsCancelled: modern.streamsCancelled },
        legacy: { calls: legacy.calls, writes: legacy.writes, sessions: legacy.sessions.size },
        helpdesk: { calls: helpdesk.calls, writes: helpdesk.writes, violations: helpdesk.violations },
        rest: { requests: rest.requests, notes: rest.notes },
        login: { clientDocFetches: as.clientDocFetches, registrations: as.registrations, tokenRequests: as.tokenRequests, revoked: as.revoked.length },
      })) as Record<string, unknown>
    },
  }
}

export type McpFixtures = ReturnType<typeof createMcpFixtures>
