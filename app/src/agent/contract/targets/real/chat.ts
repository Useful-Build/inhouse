// P3's chat-track parts of the real target, in the style of members.ts and grants.ts: memory (routes 43 to 45) and
// usage (route 42). What's particular here: the client reads both pages from fixed paths, and a forget goes to route 44
// or 45 by the line's scope, which only the read shows. W7 PR 1; the chat methods (C4, C5) join in PR 2 on W5's real client.
//
// Lines the orchestrator adds to index.ts (an orchestrator-only file):
//   import { CHAT_READ_PATH, forgetRoute } from './chat'
//   SERVED gains 'forgetMemory'; READ_PATH gains ...CHAT_READ_PATH; routeOf's `forgetMemory` case awaits `forgetRoute(s, who, key)`.
// No fact can be made by any route (only the agent's tools write memory), so a fixture line has to be seeded under the
// test build; that is left to the orchestrator (members.ts: a second writer on wrangler's open SQLite file isn't safe).
import { findMemoryLine, forgetPath } from '../../../http/memory'
import type { MemoryData } from '../../../../../shared/contract/memory'
import type { ResourceKey } from '../../../types'
import type { Seeded, Signer } from './me'

/** The paths the client reads the Memory and Usage pages from (`readMemory`, `readUsage`). */
export const CHAT_READ_PATH: Partial<Record<ResourceKey, string>> = { memory: '/api/memory', usage: '/api/usage' }

/**
 * The route a `forgetMemory(key, forgotten)` call sends to, found the way the client finds it: read the page as `who`,
 * take the line's scope, and use the matching route (a team line 45, the person's own 44). Fails loud when the page can't
 * be read or `who` has no such line, never guesses a scope.
 */
export async function forgetRoute(s: Signer, who: Seeded, key: string): Promise<{ verbs: string[]; path: string }> {
  const page = await s.api(who, 'GET', CHAT_READ_PATH.memory!)
  if (page.status !== 200) throw new Error(`The real contract target couldn't read the memory page: ${page.status}`)
  const found = findMemoryLine(page.json as MemoryData, key)
  if (!found) throw new Error(`The real contract target found no memory line ${key} for ${who}.`)
  return { verbs: ['PUT'], path: forgetPath(key, found.scope) }
}

/** The usage read's path for a month (`YYYY-MM`), or this month's when omitted. */
export const usagePath = (month?: string): string => (month === undefined ? '/api/usage' : `/api/usage?month=${encodeURIComponent(month)}`)
