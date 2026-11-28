// Stage 1 M4 (M4-A, #675): every connection method frozen in the contract before M4-R1 lands it answers `not_built` to a
// `server` scope and `invalid_args` to any other, through the Worker's exports, and reads nothing it was sent. Ways it
// can go wrong, written first: a stub answers ok or another code (a caller would treat a half-built method as working);
// a `run` scope gets past the scope check; a malformed request throws instead of answering.
import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { CallerScope, ConnectGateway, HubResult } from '../index/contract'

const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-nb' }
const run: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-nb' }
const gateway = exports as unknown as Record<'ConnectGateway', Record<string, (scope: CallerScope, req?: unknown) => Promise<HubResult<unknown>>>>

/** Each new method, with a well-formed and a malformed request. The list is typed so a method missing here fails the typecheck. */
const actor = { kind: 'inhouse', memberId: 'mem_test_0001' }
const METHODS: Record<Extract<keyof ConnectGateway, 'detectConnection' | 'prepareConnection' | 'getConnection' | 'updateConnection' | 'setTrusted'
  | 'startConnectionSignIn' | 'setConnectionCredential' | 'checkConnection' | 'listConnectionTools' | 'confirmConnectionTools' | 'removeConnection'
  | 'listConnections' | 'listWriteTools'>, unknown> = {
  detectConnection: { actor, url: 'https://mcp.example.com/mcp' },
  prepareConnection: { actor, slug: 'helpdesk', adminMaySignIn: false, binding: { transport: 'connector', connector: 'rest-fixture', settings: {} } },
  getConnection: { actor, accountId: 'mcp:helpdesk' },
  updateConnection: { actor, accountId: 'mcp:helpdesk', ifRev: 1 },
  setTrusted: { actor, accountId: 'mcp:helpdesk', trusted: true, ifRev: 1 },
  startConnectionSignIn: { actor, accountId: 'mcp:helpdesk' },
  setConnectionCredential: { actor, accountId: 'mcp:helpdesk', credential: { kind: 'key', key: 'sk_test_canary' } },
  checkConnection: { actor, accountId: 'mcp:helpdesk' },
  listConnectionTools: { actor, accountId: 'mcp:helpdesk' },
  confirmConnectionTools: { actor, accountId: 'mcp:helpdesk', generation: 1, ifRev: 1, tools: [{ name: 'search', defHash: 'a'.repeat(64), mode: 'read' }] },
  removeConnection: { actor, accountId: 'mcp:helpdesk' },
  listConnections: undefined,
  listWriteTools: undefined,
}

describe('ConnectGateway: the M4 methods answer not_built until M4-R1 lands them', () => {
  for (const [method, req] of Object.entries(METHODS)) {
    it(`${method}: not_built for a server scope, invalid_args for any other, and nothing of the request in the answer`, async () => {
      const built = await gateway.ConnectGateway[method]!(server, req)
      expect(built).toEqual({ ok: false, error: { code: 'not_built', message: `not built yet: ${method}` } })
      // A malformed request answers the same: the stub reads nothing.
      expect(await gateway.ConnectGateway[method]!(server, { junk: true })).toEqual(built)
      expect(await gateway.ConnectGateway[method]!(run, req)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
      expect(JSON.stringify(built)).not.toContain('sk_test_canary')
    })
  }
})
