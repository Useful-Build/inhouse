// P3's chat-track parts of the real target, in the style of members.ts and grants.ts: memory (routes 43 to 45) and
// usage (route 42). What's particular here: the client reads both pages from fixed paths, and a forget goes to route 44
// or 45 by the line's scope, which only the read shows. W7 PR 1; the chat methods (C4, C5) join in PR 2 on W5's real client
// (`CHAT_SERVED`, `chatRoute`, `freshChat`, below), and the memory fact `forgetMemory` needs is made by a scripted chat turn
// (`seedMemoryFact`), which needs a container: until index.ts serves it (the SERVED lines are in the PR body), it stays exempt.
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
  forgetMemory: 'no route creates a memory fact until a chat turn can run on the test build (W7 PR 2, Q2 deployment); the contract suite has no local D1 to seed in remote mode (the API specs seed with writeSql, a second writer, which the contract target avoids)',
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

// ---------- W7 PR 2: the chat methods (C4 chat history and management, C5 pause and resume) ----------

/** The chat and pause methods W5's real client sends over HTTP (routes 23, 25 to 28, 36, 37): what index.ts adds to SERVED. */
export const CHAT_SERVED = ['createChat', 'renameChat', 'pinChat', 'deleteChats', 'restoreChats', 'pause', 'resume'] as const

const enc = (v: unknown): string => encodeURIComponent(String(v))

/** The route a served chat or pause write sends to (its verbs and exact path), from the call's arguments; null for any other method. */
export function chatRoute(method: string, args: unknown[]): { verbs: string[]; path: string } | null {
  switch (method) {
    case 'createChat': return { verbs: ['POST'], path: '/api/chats' }
    case 'renameChat': return { verbs: ['PUT'], path: `/api/chats/${enc(args[0])}/title` }
    case 'pinChat': return { verbs: ['PUT'], path: `/api/chats/${enc(args[0])}/pin` }
    case 'deleteChats': return { verbs: ['POST'], path: '/api/chats/delete' }
    case 'restoreChats': return { verbs: ['POST'], path: '/api/chats/restore' }
    case 'pause': return { verbs: ['POST'], path: '/api/pause' }
    case 'resume': return { verbs: ['POST'], path: '/api/resume' }
    default: return null
  }
}

/**
 * The `newChat` fixture for the n-th reset: a chat can't be erased through the API, and a create of an id the person already
 * has answers the chat as it is now (idempotent), so one fixed id would carry a rename or a delete from one test into the next.
 * An id per reset starts every test with an untouched chat.
 */
export const freshChat = (n: number, nonce: string): { id: string; title: string } => ({ id: `contract-chat-${nonce}-${n}`, title: 'A new chat' })

/** The text the scripted `memory-save` scenario saves (app/test/scripted-model/scenarios.ts), checked by a test against that file. */
export const SEEDED_MEMORY_TEXT = 'Likes the weekly stock report as a table.'

/**
 * Makes a memory line through the API alone: the person sends a turn that plays the `memory-save` scenario (a container runs it, so
 * only the per-PR deployment can), then reads the page until their own line with that text shows, and returns its key.
 * Fails loud when the turn never makes the line, never guesses a key.
 */
export async function seedMemoryFact(s: Signer, who: Seeded, o: { chatId: string; timeoutMs?: number; sleep?: (ms: number) => Promise<void> }): Promise<string> {
  const known = async (): Promise<Set<string>> => {
    const page = await s.api(who, 'GET', CHAT_READ_PATH.memory!)
    if (page.status !== 200) throw new Error(`The real contract target couldn't read the memory page: ${page.status}`)
    return new Set((page.json as MemoryData).personal.map(l => l.key))
  }
  const before = await known()
  const made = await s.api(who, 'POST', '/api/chats', { id: o.chatId, title: 'Memory seed' })
  if (made.status !== 200) throw new Error(`The real contract target couldn't make the seed chat: ${made.status}`)
  const sent = await s.api(who, 'POST', `/api/chats/${enc(o.chatId)}/turns`, { clientTurnKey: `contract-seed-${o.chatId}`.slice(0, 64), text: 'scenario:memory-save remember this', model: 'sonnet' })
  if (![200, 201, 202].includes(sent.status)) throw new Error(`The real contract target couldn't send the seed turn: ${sent.status}`)
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const until = Date.now() + (o.timeoutMs ?? 120_000)
  for (;;) {
    const page = await s.api(who, 'GET', CHAT_READ_PATH.memory!)
    if (page.status !== 200) throw new Error(`The real contract target couldn't read the memory page: ${page.status}`)
    const line = (page.json as MemoryData).personal.find(l => l.text === SEEDED_MEMORY_TEXT && !before.has(l.key))
    if (line) return line.key
    if (Date.now() > until) throw new Error('The seed turn made no memory line in time.')
    await sleep(1000)
  }
}
