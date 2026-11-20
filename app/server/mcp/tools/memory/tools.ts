// The memory tools (agent-tools "1. Memory", p3-design section 10): search, save, update, forget, list, as the run's
// person. Their names and descriptions are the registry's (server/mcp/registry.ts); their inputs and answers are here.
import { z } from 'zod'
import { MemoryIdSchema } from '../../../../shared/contract/memory.ts'
import { decodeCursor, encodeCursor } from '../../../db/handler-kit.ts'
import { answer, refusal, tool } from '../../server/tool.ts'
import type { ToolImpl, ToolResult } from '../../server/tool.ts'
import { personalDataRefusal } from './personal-data.ts'
import type { Fact, MemoryStore, WriteRefusal } from './store.ts'

const memoryId = MemoryIdSchema.describe('The `memory_id` that `memory_search` or `memory_list` returned, like "mem_…".')
const text = z.string().trim().min(1).max(500).describe('The fact in one sentence, at most 500 characters.')

/** A fact as the agent reads it. */
const shown = (f: Fact) => ({
  memory_id: f.id,
  scope: f.scope,
  text: f.text,
  ...(f.status === 'waiting' ? { waiting_for_admin: true } : {}),
  saved: new Date(f.createdAtMs).toISOString().slice(0, 10),
})
const line = (f: Fact) => `- [${f.scope}] ${f.text} (memory_id: ${f.id})`

const NOT_FOUND = (id: string) => refusal('not_found', `No saved fact you can see has memory_id "${id}". Use memory_search to find the fact and its memory_id, then try again.`)
const CONFLICT = refusal('conflict', 'That fact changed while you were working on it. Search for it again and retry with what it says now.')

function refused(r: WriteRefusal): ToolResult {
  switch (r.refused) {
    case 'personal_data': return refusal('personal_data', personalDataRefusal(r.kind))
    case 'service_person_fact': return refusal('person_scope_in_routine', 'Not saved: a routine runs for nobody in particular, so it can\'t save a "person" fact. Save it with scope "brand" if the whole team should know it, or leave it.')
    case 'no_member': return refusal('no_member', "Not saved: the person you're helping is no longer on the team.")
  }
}

export function memoryTools(store: MemoryStore): Record<string, ToolImpl> {
  return {
    memory_search: tool({
      input: z.object({
        query: z.string().min(1).max(200).describe('Keywords, or "an exact phrase" in double quotes. Any of the words can match; best matches first.'),
        limit: z.number().int().min(1).max(20).default(10).describe('At most this many facts (1 to 20).'),
      }).strict(),
      async call({ query, limit }, scope) {
        const facts = await store.search(scope.memberId, query, limit, scope.nowMs)
        if (facts.length === 0) return answer(`Nothing saved matches "${query}". Try other words, or memory_list to look through everything.`, { facts: [] })
        return answer(`${facts.length} saved ${facts.length === 1 ? 'fact matches' : 'facts match'}:\n${facts.map(line).join('\n')}`, { facts: facts.map(shown) })
      },
    }),

    memory_save: tool({
      input: z.object({
        scope: z.enum(['brand', 'person']).describe('"brand": the whole team shares it (waits for an admin\'s OK). "person": the preference of the person you\'re helping (counts at once).'),
        text,
      }).strict(),
      async call({ scope: factScope, text: t }, scope) {
        const r = await store.save({ memberId: scope.memberId, scope: factScope, text: t, chatId: scope.chatId, nowMs: scope.nowMs, requestId: scope.requestId })
        if ('refused' in r) return refused(r)
        if ('duplicate' in r) return answer(`Already saved, nothing changed (memory_id: ${r.duplicate.id}).`, { fact: shown(r.duplicate), already_saved: true })
        const f = r.saved
        return answer(
          f.scope === 'brand'
            ? `Saved for the team (memory_id: ${f.id}). It waits for an admin's OK, so don't rely on it until then.`
            : `Saved (memory_id: ${f.id}). It counts from now, for this person only.`,
          { fact: shown(f) },
        )
      },
    }),

    memory_update: tool({
      input: z.object({ memory_id: memoryId, text }).strict(),
      async call({ memory_id, text: t }, scope) {
        const r = await store.update({ memberId: scope.memberId, id: memory_id, text: t, nowMs: scope.nowMs, requestId: scope.requestId })
        if ('refused' in r) return refused(r)
        if ('notFound' in r) return NOT_FOUND(memory_id)
        if ('conflict' in r) return CONFLICT
        if ('unchanged' in r) return answer(`It already says that, nothing changed (memory_id: ${memory_id}).`, { fact: shown(r.unchanged) })
        const f = r.updated
        return answer(
          f.scope === 'brand'
            ? `Changed (memory_id: ${f.id}). A team fact waits for an admin's OK again after a change, so don't rely on it until then.`
            : `Changed (memory_id: ${f.id}).`,
          { fact: shown(f) },
        )
      },
    }),

    memory_forget: tool({
      input: z.object({ memory_id: memoryId }).strict(),
      async call({ memory_id }, scope) {
        const r = await store.forgetOwn({ memberId: scope.memberId, id: memory_id, nowMs: scope.nowMs, requestId: scope.requestId })
        if ('notFound' in r) return NOT_FOUND(memory_id)
        if ('conflict' in r) return CONFLICT
        if ('brandFact' in r) return refusal('team_fact', 'Not forgotten: this is a team fact, and only an admin can forget those (Settings, Team memory). If it\'s wrong, use memory_update to correct it, or tell the person to ask an admin.')
        return answer(`Forgotten (memory_id: ${memory_id}).`, { memory_id, forgotten: true })
      },
    }),

    memory_list: tool({
      input: z.object({
        scope: z.enum(['brand', 'person']).optional().describe('Only team facts ("brand") or only this person\'s ("person"). Both when left out.'),
        cursor: z.string().max(64).optional().describe('The `next_cursor` of the previous page.'),
        limit: z.number().int().min(1).max(50).default(20).describe('At most this many facts per page (1 to 50).'),
      }).strict(),
      async call({ scope: only, cursor, limit }, scope) {
        let beforeN: number | null = null
        if (cursor !== undefined) {
          const key = decodeCursor(cursor)
          if (key === null || !/^[1-9]\d{0,15}$/.test(key)) return refusal('invalid_cursor', 'That cursor isn\'t one memory_list gave. Leave `cursor` out to start from the newest.')
          beforeN = Number(key)
        }
        const rows = await store.list(scope.memberId, { scope: only, beforeN, limit: limit + 1 })
        const facts = rows.slice(0, limit)
        const next = rows.length > limit ? encodeCursor(String(facts[facts.length - 1].n)) : null
        const head = facts.length === 0 ? 'No saved facts.' : `${facts.length} saved ${facts.length === 1 ? 'fact' : 'facts'}, newest first:\n${facts.map(line).join('\n')}`
        return answer(next ? `${head}\nMore: call memory_list with cursor "${next}".` : head, { facts: facts.map(shown), next_cursor: next })
      },
    }),
  }
}
