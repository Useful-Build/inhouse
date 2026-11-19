// The spec fixture `fx`: sample names, and seeding or resetting the app's state, without a spec knowing the mock's
// storage keys or its sample strings. Specs opt in with: import { expect, test } from './support/fx.js'
// `test` is the CSP guard's test (../csp.ts) plus `fx`, so every spec that uses it keeps the guard.
import { expect, test as base } from '../csp.js'
import { mockClient } from './clients/mock.js'

export type { Names, Seed, Stage, Theme } from './clients/mock.js'
export type Fx = ReturnType<typeof mockClient>

export const test = base.extend<{ fx: Fx }>({
  fx: async ({ page }, provide) => { await provide(mockClient(page)) },
})

export { expect }
