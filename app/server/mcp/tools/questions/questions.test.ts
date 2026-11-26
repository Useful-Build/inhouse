// `question_ask` (Stage 1 M2-Q, N16). Ways it could fail, written first:
//  1. it asks (writes a question) from the tool call, so a call beside another one, or a replay, makes a second
//     question; or it reads a question by its call id across chats;
//  2. the call the SDK runs again on the resume doesn't return the option chosen, or returns an answer for an expired
//     or withdrawn question;
//  3. the call's id isn't taken from the CLI's `_meta["claudecode/toolUseId"]` on `tools/call`, or a malformed one is.
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { handleMcp } from '../../server/index.ts'
import type { ToolScope } from '../../server/tool.ts'
import { ASK_ALONE_TEXT, CLOSED_TEXT, EXPIRED_TEXT, handlers } from './index.ts'

const db = env.DB
const CHAT = 'c-mcp-q'
const NOW = 1_800_000_000_000
const ask = handlers.question_ask!
const scope = (toolUseId?: string, chatId = CHAT): ToolScope =>
  ({ memberId: 'm_mcpq', chatId, runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA', nowMs: NOW, requestId: 'req-1', ...(toolUseId ? { toolUseId } : {}) })
const ARGS = { question: 'Which?', options: ['Yes', 'No'] }

async function seed(id: string, toolUseId: string, state: string, answer: string | null) {
  await db.prepare(`INSERT INTO questions (id, chat_id, turn_id, tool_use_id, asked_of, asked_as, question, options_json, state, answer, answered_by,
    answered_at_ms, created_at_ms, expires_at_ms, ended_at_ms) VALUES (?, ?, 't_x', ?, 'm_mcpq', 'owner', 'Which?', '["Yes","No"]', ?, ?, ?, ?, 0, 1, ?)`)
    .bind(id, CHAT, toolUseId, state, answer, answer === null ? null : 'm_mcpq', answer === null ? null : 1, state === 'open' ? null : 1).run()
}

beforeAll(async () => {
  await seed('q_mcpAnsweredAAAAAAAAAAA', 'tu_answered', 'answered', 'No')
  await seed('q_mcpExpiredAAAAAAAAAAAA', 'tu_expired', 'expired', null)
  await seed('q_mcpClosedAAAAAAAAAAAAA', 'tu_closed', 'closed', null)
  await seed('q_mcpOpenAAAAAAAAAAAAAAA', 'tu_open', 'open', null)
})

describe('question_ask reads, never asks (failures 1 and 2)', () => {
  it('a call with no question (not deferred, or no call id) is told to ask on its own, and writes nothing', async () => {
    const before = await db.prepare('SELECT COUNT(*) AS n FROM questions').first<number>('n')
    for (const s of [scope(), scope('tu_never'), scope('tu_answered', 'c-another-chat')]) {
      const r = await ask.call(ARGS, s, { db })
      expect(r).toEqual({ content: [{ type: 'text', text: ASK_ALONE_TEXT }], structuredContent: { error: 'ask_alone' }, isError: true })
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM questions').first<number>('n')).toBe(before)
  })

  it('the resumed call returns the option chosen; an expired, withdrawn or unanswered one says so', async () => {
    expect(await ask.call(ARGS, scope('tu_answered'), { db })).toMatchObject({
      content: [{ type: 'text', text: 'The person chose: "No".' }, { type: 'text' }], structuredContent: { question_id: 'q_mcpAnsweredAAAAAAAAAAA', state: 'answered', answer: 'No' },
    })
    expect(await ask.call(ARGS, scope('tu_expired'), { db })).toMatchObject({ content: [{ text: EXPIRED_TEXT }], structuredContent: { error: 'question_expired' }, isError: true })
    expect(await ask.call(ARGS, scope('tu_closed'), { db })).toMatchObject({ content: [{ text: CLOSED_TEXT }], structuredContent: { error: 'question_closed' }, isError: true })
    expect(await ask.call(ARGS, scope('tu_open'), { db })).toMatchObject({ structuredContent: { error: 'not_answered' }, isError: true })
  })
})

describe("the call's id from the CLI (failure 3)", () => {
  const call = async (meta: unknown) => {
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'question_ask', arguments: ARGS, ...(meta === undefined ? {} : { _meta: meta }) } }
    const res = await handleMcp(new Request('http://egress.internal/mcp/', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
      { memberId: 'm_mcpq', chatId: CHAT, runId: 'r_AAAAAAAAAAAAAAAAAAAAAA', turnId: 't_AAAAAAAAAAAAAAAAAAAAAA' }, { db, now: () => NOW })
    return ((await res.json()) as { result: { structuredContent: Record<string, unknown> } }).result.structuredContent
  }
  it('`_meta["claudecode/toolUseId"]` names the call; none, or a malformed one, names none', async () => {
    expect(await call({ 'claudecode/toolUseId': 'tu_answered' })).toEqual({ question_id: 'q_mcpAnsweredAAAAAAAAAAA', state: 'answered', answer: 'No' })
    for (const meta of [undefined, {}, { 'claudecode/toolUseId': 7 }, { 'claudecode/toolUseId': 'tu answered' }, { toolUseId: 'tu_answered' }, 'tu_answered']) {
      expect(await call(meta)).toEqual({ error: 'ask_alone' })
    }
  })
})
