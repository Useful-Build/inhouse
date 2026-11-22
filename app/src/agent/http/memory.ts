// The Memory and Team memory pages over HTTP (P3, p3-design sections 3 and 10, W6): route 43 reads both lists, routes
// 44 and 45 forget a line or undo that. No zod here (the entry's size budget, schemas.ts): the transport parses each
// answer with the lazily loaded schemas, and a body is built from them by the caller's `Contract`.
// The client (client.ts, wired by its owner) keeps each line's last `rev` and sends it as `ifRev`; a `conflict` carries
// the line as it is now in `current`.
import type { MemoryData, MemoryLine } from '../../../shared/contract/memory'
import type { WaitingMemoryList } from '../../../shared/contract/memory-approvals'
import type { Contract, Transport } from './transport'

/** Route 43: the team's lines (grouped) and the signed-in person's own. */
export const readMemory = (http: Transport): Promise<MemoryData> => http.call({ method: 'GET', path: '/api/memory', schema: 'memory' })

/** Where a line's forget goes: a team line to route 45 (Admins, or the Inhouse team under a grant), a person's own to 44. */
export const forgetPath = (key: string, scope: 'brand' | 'person'): string =>
  `/api/memory/${scope === 'brand' ? 'brand' : 'personal'}/${encodeURIComponent(key)}/forgotten`

/** The line `key` names in `data`, with its scope (a team line is `brand`), or null. */
export function findMemoryLine(data: MemoryData, key: string): { line: MemoryLine; scope: 'brand' | 'person' } | null {
  for (const g of data.team) {
    const line = g.lines.find(l => l.key === key)
    if (line) return { line, scope: 'brand' }
  }
  const own = data.personal.find(l => l.key === key)
  return own ? { line: own, scope: 'person' } : null
}

/**
 * Routes 44 and 45: forgets the line (`forgotten: true`) or undoes that, at the rev last read. Answers the line as the
 * server holds it after the write; rejects with the transport's `AgentError` (a conflict carries `current`).
 */
export function forgetMemoryLine(http: Transport, k: Contract, line: { key: string; rev: number }, scope: 'brand' | 'person', forgotten: boolean): Promise<MemoryLine> {
  return http.call({
    method: 'PUT', path: forgetPath(line.key, scope), schema: 'memoryLine',
    json: k.BODIES.memoryForget.parse({ forgotten, ifRev: line.rev }),
  })
}

/** Route 77: the team facts waiting for an OK, newest first (Admins, and the Inhouse team under a grant). */
export async function readWaitingMemory(http: Transport): Promise<WaitingMemoryList> {
  const list = await http.call({ method: 'GET', path: '/api/memory/waiting', schema: 'waitingMemory' })
  // Only a team line still waiting belongs here (a contract follow-up pins WaitingMemorySchema to these literals).
  return { facts: list.facts.filter(f => f.scope === 'brand' && f.waiting === true) }
}

/**
 * Route 78: approves (`true`) or rejects a waiting team fact at the rev last read. Answers the line as the server holds
 * it after the write; rejects with the transport's `AgentError` (a conflict carries `current`).
 */
export function reviewMemoryLine(http: Transport, k: Contract, line: { key: string; rev: number }, approved: boolean): Promise<MemoryLine> {
  return http.call({
    method: 'PUT', path: `/api/memory/brand/${encodeURIComponent(line.key)}/approved`, schema: 'memoryLine',
    json: k.BODIES.memoryApprove.parse({ approved, ifRev: line.rev }),
  })
}

/**
 * Whether a conflict's `current` already shows the decision sent at `ifRev`: an earlier send landed and its answer was
 * lost, so it counts as done. An approve has landed only when the line is one rev on and active (neither waiting nor
 * forgotten); a reject when it is one rev on and forgotten (an admin's forget at that rev reads as done too).
 */
export const reviewLanded = (current: MemoryLine, ifRev: number, approved: boolean): boolean =>
  current.rev === ifRev + 1 && (approved ? current.forgotten !== true && current.waiting !== true : current.forgotten === true)
