// ConnectGateway.testFakes's refusals, decided as a plain function so the node project tests both builds (the pattern of
// index/test-shop.ts): the deployable hub (`__INHOUSE_HUB_TEST__` false) and the test bundle. The entrypoint (entry.ts)
// passes `testBuild` as the guard written out in full and imports the hook only inside that same guard.
import type { HubResult } from '../index/contract'
import { err } from '../index/errors'
import { CallerScopeSchema } from '../index/schemas'

/** Null: go on (the test bundle, a `server` scope). Otherwise the refusal. Outside the test bundle, whatever the scope. */
export function refuseTestFakes(testBuild: boolean, scope: unknown): HubResult<never> | null {
  if (!testBuild) return err('not_configured', 'testFakes')
  const parsed = CallerScopeSchema.safeParse(scope)
  if (!parsed.success || parsed.data.kind !== 'server') return err('invalid_args', 'scope')
  return null
}
