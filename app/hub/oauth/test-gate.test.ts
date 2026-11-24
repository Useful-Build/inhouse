// ConnectGateway.testFakes's refusals (test-gate.ts), in node, for both builds. Ways it can fail, written down first:
//  1. the deployable hub (testBuild false) answers anything but not_configured for some scope, a server one included;
//  2. the test bundle lets a run scope, a member-shaped or malformed scope through;
//  3. the test bundle refuses a well-formed server scope.
import { describe, expect, it } from 'vitest'
import { refuseTestFakes } from './test-gate'

const SCOPES: unknown[] = [
  { kind: 'server', job: 'test-fakes', requestId: 'r1' },
  { kind: 'run', runId: 'run-1', principalId: 'm_member', requestId: 'r2' },
  { kind: 'member', memberId: 'm_admin', role: 'admin', requestId: 'r3' },
  { kind: 'server', job: 'test-fakes', requestId: 'r4', extra: true },
  null,
  'server',
]

describe('refuseTestFakes', () => {
  it('the deployable hub: not_configured, whatever the scope (failure 1)', () => {
    for (const scope of SCOPES) expect(refuseTestFakes(false, scope), JSON.stringify(scope)).toEqual({ ok: false, error: { code: 'not_configured', message: 'connector not configured: testFakes' } })
  })
  it('the test bundle: invalid_args for every scope but a well-formed server one (failures 2 and 3)', () => {
    const [server, ...rest] = SCOPES
    expect(refuseTestFakes(true, server)).toBeNull()
    for (const scope of rest) expect(refuseTestFakes(true, scope), JSON.stringify(scope)).toEqual({ ok: false, error: { code: 'invalid_args', message: 'invalid arguments: scope' } })
  })
})
