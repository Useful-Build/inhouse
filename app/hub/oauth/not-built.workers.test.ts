// Stage 1 M4 (M4-A #675, then M4-R1): every connection method a later package owns answers `not_built` to a well-formed
// `server` request, `invalid_args` to a malformed one and to any other scope, through the Worker's exports, and echoes
// nothing it was sent. M4-R1 parses each request before its hook (M4-A's stubs read nothing, so a malformed request
// answered `not_built` there); prepare, get, update, remove and the list are built (connections.workers.test.ts).
// Ways it can go wrong, written first: a hook answers ok or another code (a caller would treat a half-built method as
// working); a `run` scope gets past the scope check; a malformed request throws instead of answering.
import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { CallerScope, ConnectGateway, HubResult } from '../index/contract'

const server: CallerScope = { kind: 'server', job: 'test', requestId: 'req-nb' }
const run: CallerScope = { kind: 'run', runId: 'run-1', principalId: 'p-1', requestId: 'req-nb' }
const gateway = exports as unknown as Record<'ConnectGateway', Record<string, (scope: CallerScope, req?: unknown) => Promise<HubResult<unknown>>>>

/** Each hooked method, with a well-formed request. The list is typed so a method missing here fails the typecheck. */
const actor = { kind: 'inhouse', memberId: 'mem_test_0001' }
const METHODS: Record<Extract<keyof ConnectGateway, 'detectConnection' | 'setTrusted' | 'startConnectionSignIn' | 'setConnectionCredential' | 'checkConnection'
  | 'listConnectionTools' | 'confirmConnectionTools' | 'listWriteTools'>, unknown> = {
  detectConnection: { actor, url: 'https://mcp.example.com/mcp' },
  setTrusted: { actor, accountId: 'mcp:helpdesk', trusted: true, ifRev: 1 },
  startConnectionSignIn: { actor, accountId: 'mcp:helpdesk' },
  setConnectionCredential: { actor, accountId: 'mcp:helpdesk', credential: { kind: 'key', key: 'sk_test_canary' } },
  checkConnection: { actor, accountId: 'mcp:helpdesk' },
  listConnectionTools: { actor, accountId: 'mcp:helpdesk' },
  confirmConnectionTools: { actor, accountId: 'mcp:helpdesk', generation: 1, ifRev: 1, tools: [{ name: 'search', defHash: 'a'.repeat(64), mode: 'read' }] },
  listWriteTools: undefined,
}

describe('ConnectGateway: the methods later packages own answer not_built until their hooks are filled', () => {
  for (const [method, req] of Object.entries(METHODS)) {
    it(`${method}: not_built for a server scope, invalid_args for a malformed request or any other scope, and nothing of the request in the answer`, async () => {
      const built = await gateway.ConnectGateway[method]!(server, req)
      expect(built).toEqual({ ok: false, error: { code: 'not_built', message: `not built yet: ${method}` } })
      if (req !== undefined) expect(await gateway.ConnectGateway[method]!(server, { junk: true })).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: req' } })
      expect(await gateway.ConnectGateway[method]!(run, req)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
      expect(JSON.stringify(built)).not.toContain('sk_test_canary')
    })
  }
})
