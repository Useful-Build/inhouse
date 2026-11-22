// schemas.ts and contract.ts must agree. The expectTypeOf lines are checked by `npm run typecheck` (tsc includes test
// files); the runtime cases check that the schemas accept and refuse what the types say.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { AccountStatus, CallerScope, CallToolOptions, HubError, HubErrorCode, HubResult, Instant, SignInState, ToolInfo } from './contract'
import {
  AccountStatusSchema,
  CallerScopeSchema,
  CallToolOptionsSchema,
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
    expectTypeOf<z.infer<typeof CallToolOptionsSchema>>().toEqualTypeOf<CallToolOptions>()
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

  // The read call's options (the test shop override): ways it can go wrong, written first. A host that isn't a Shopify
  // host (another domain, a path, a port, upper case, a bare handle) or an unknown key must not parse, so the hub never
  // builds a URL from it and nothing rides along under a new name.
  it('call options parse strictly', () => {
    expect(CallToolOptionsSchema.safeParse({}).success).toBe(true)
    expect(CallToolOptionsSchema.safeParse({ testShopHost: 'example-mc-late-orders.myshopify.com' }).success).toBe(true)
    for (const testShopHost of ['example-mc-late-orders', 'evil.example', 'a.myshopify.com.evil.example', 'a.myshopify.com/x', 'a.myshopify.com:443', 'A.myshopify.com', '-a.myshopify.com', '.myshopify.com', ''])
      expect(CallToolOptionsSchema.safeParse({ testShopHost }).success, testShopHost).toBe(false)
    expect(CallToolOptionsSchema.safeParse({ testShopHost: 'a.myshopify.com', shop: 'b' }).success).toBe(false)
    expect(CallToolOptionsSchema.safeParse({ testShopHost: 1 }).success).toBe(false)
  })
})
