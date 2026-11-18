// The one place the app picks its agent. Phase 2 replaces MockAgent with the
// real agent client; nothing else changes.
import { MockAgent } from './mock'
import type { AgentClient } from './types'

export const agent: AgentClient = new MockAgent()
export * from './types'
