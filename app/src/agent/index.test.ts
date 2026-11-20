// The exports of src/agent/index.ts are typed as the interfaces (AgentClient, DemoControls | null), not as the demo entry's own
// narrower types. Each `@ts-expect-error` below fails `npm run typecheck` if that line starts to compile: the demo entry's
// `MockAgent` has `setDemo` and its `demo` is never null, so without the annotations the product's null `demo` and missing
// `setDemo` would type-check and throw at run time. The functions are never called.
import { expect, test, vi } from 'vitest'

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
const { agent, demo, now } = await import('./index')

test('agent has no setDemo and demo is nullable (checked by tsc)', () => {
  const calls = () => {
    // @ts-expect-error `setDemo` is a demo control, not part of AgentClient
    agent.setDemo({ stage: 'Act', scenario: 'Normal' })
    // @ts-expect-error `demo` is null in the product build: call it with `?.`
    demo.reset()
    demo?.reset()
  }
  expect(calls).toBeTypeOf('function')
  expect(now()).toEqual(expect.any(Number))
})
