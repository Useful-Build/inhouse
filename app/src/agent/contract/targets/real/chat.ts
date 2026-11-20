// P3's chat-track parts of the real target, in the style of members.ts and grants.ts: memory (routes 43 to 45) and
// usage (route 42). What's particular here: the client reads both pages from fixed paths, and a forget goes to route 44
// or 45 by the line's scope, which only the read shows. W7 PR 1; the chat methods (C4, C5) join in PR 2 on W5's real client.
//
// `forgetMemory` is EXEMPT on the real target (A5, 2026-11-20): it stays out of index.ts's SERVED, so the contract suite
// skips its tests by name, with the reason below. index.ts needs no change until the exemption goes (then: 'forgetMemory'
// in SERVED, the import of CHAT_READ_PATH and forgetRoute, `...CHAT_READ_PATH` in READ_PATH, routeOf's forgetMemory case).
// The later PR that removes the exemption is W7 PR 2 (feat/chat-w7-specs): on the Q2 test deployment a chat turn runs, so
// the agent's memory_save makes the fact through the API alone.

import { findMemoryLine, forgetPath } from '../../../http/memory'
import type { MemoryData } from '../../../../../shared/contract/memory'
import type { ResourceKey } from '../../../types'
import type { Seeded, Signer } from './me'

/** Client methods the real target doesn't serve yet, each with why (the suite skips them by name). */
export const CHAT_EXEMPT: Readonly<Record<string, string>> = {
  forgetMemory: 'no route creates a memory fact until a chat turn can run on the test build (W7 PR 2, Q2 deployment); seeding would need a second writer on wrangler\'s open SQLite file',
}

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
