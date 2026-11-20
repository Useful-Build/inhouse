// schemas.ts and contract.ts must agree. The expectTypeOf lines are checked by `npm run typecheck` (tsc includes test
// files); the runtime cases check that the schemas accept and refuse what the types say.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { AccountStatus, CallerScope, HubError, HubErrorCode, HubResult, Instant, SignInState, ToolInfo } from './contract'
import {
  AccountStatusSchema,
  CallerScopeSchema,
  HubErrorCodeSchema,
  HubErrorSchema,
  hubResultSchema,
  InstantSchema,
  SignInStateSchema,
  ToolInfoSchema,
} from './schemas'

describe('schemas.ts mirrors contract.ts', () => {
  it('types agree', () => {
    expectTypeOf<z.infer<typeof InstantSchema>>().toEqualTypeOf<Instant>()
    expectTypeOf<z.infer<typeof CallerScopeSchema>>().toEqualTypeOf<CallerScope>()
    expectTypeOf<z.infer<typeof HubErrorCodeSchema>>().toEqualTypeOf<HubErrorCode>()
    expectTypeOf<z.infer<typeof HubErrorSchema>>().toEqualTypeOf<HubError>()
    expectTypeOf<z.infer<typeof ToolInfoSchema>>().toEqualTypeOf<ToolInfo>()
    expectTypeOf<z.infer<typeof SignInStateSchema>>().toEqualTypeOf<SignInState>()
    expectTypeOf<z.infer<typeof AccountStatusSchema>>().toEqualTypeOf<AccountStatus>()
    const toolList = hubResultSchema(ToolInfoSchema.array())
    expectTypeOf<z.infer<typeof toolList>>().toEqualTypeOf<HubResult<ToolInfo[]>>()
  })

  it('caller scopes parse strictly', () => {
    expect(CallerScopeSchema.safeParse({ kind: 'run', runId: 'r', principalId: 'p', requestId: 'q' }).success).toBe(true)
    expect(CallerScopeSchema.safeParse({ kind: 'server', job: 'j', requestId: 'q' }).success).toBe(true)
    expect(CallerScopeSchema.safeParse({ kind: 'run', runId: 'r', requestId: 'q' }).success).toBe(false)
    expect(CallerScopeSchema.safeParse({ kind: 'server', job: 'j', requestId: 'q', write: true }).success).toBe(false)
    expect(CallerScopeSchema.safeParse({ kind: 'admin', requestId: 'q' }).success).toBe(false)
    expect(CallerScopeSchema.safeParse({ kind: 'server', job: '', requestId: 'q' }).success).toBe(false)
  })
})
