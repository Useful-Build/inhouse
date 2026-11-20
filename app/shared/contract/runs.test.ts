// P3's chat contract (runs.ts, chats.ts, attachments.ts, requests.ts). Every expected value is a literal written here or
// the runner protocol's own rule, never read from the code under test. Ways it can fail, written down first:
//  1. a turn failure the BrandAgent reports (`budget_busy`, `max_turns`, `turn_budget`) doesn't parse, or the list drifts;
//  2. the socket accepts a frame version it can't read, or refuses version 1;
//  3. a chat id the runner refuses passes here (a run that can never start), or one it takes is refused;
//  4. a send whose composed prompt is over the runner's cap less 2,000 passes, or one at the cap is refused;
//  5. the envelope refuses a frame with an unknown `v` or event, so the client can't skip it (version-first decode);
//  6. route 23 takes a chat id or title outside its rule.
import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { RunStartFields } from '../protocol/index.ts'
import {
  AttachmentRefSchema, ChatEventSchema, ChatFrameEnvelopeSchema, ChatIdSchema, CreateChatInputSchema, PauseStateSchema,
  SendTurnInputSchema, StoredMessageSchema, TurnFailureSchema, acceptsChatVersion, composeTurnPrompt,
} from './index.ts'

const runId = 'r_0123456789abcdefABCDEF'
const turnId = 't_0123456789abcdefABCDEF'
const at = { iso: '2026-11-20T10:00:00.000Z', ms: Date.parse('2026-11-20T10:00:00.000Z') }

describe('turn failures (failure 1)', () => {
  // `model_off` (A3, 2026-11-20, from #153's review): the turn's model was switched off (or lost its price) while it
  // waited; W1 PR 2b rechecks at start.
  it('are exactly the twelve the design lists, plus model_off', () => {
    expect([...TurnFailureSchema.options].sort()).toEqual([
      'budget_busy', 'cap_reached', 'files', 'max_turns', 'model_off', 'pool_full', 'protocol', 'sdk_error', 'session_crashed',
      'store', 'timeout', 'turn_budget', 'unknown',
    ])
    for (const r of ['budget_busy', 'max_turns', 'turn_budget', 'model_off']) {
      expect(ChatEventSchema.safeParse({ type: 'turn.finished', turnId, outcome: 'failed', reason: r }).success, r).toBe(true)
    }
  })
})

describe('the socket version (failure 2)', () => {
  it('accepts 1 and nothing else', () => {
    expect(acceptsChatVersion(1)).toBe(true)
    for (const v of [0, 2, -1, 1.5, Number.NaN]) expect(acceptsChatVersion(v), String(v)).toBe(false)
  })
})

describe('chat ids (failure 3)', () => {
  const protocolChatId = RunStartFields.shape.chatId
  test.prop([fc.oneof(fc.string({ maxLength: 70 }), fc.string({ unit: fc.constantFrom(...'aZ09_-.~ /é'), maxLength: 70 }))])(
    'match the runner protocol on any string',
    s => { expect(ChatIdSchema.safeParse(s).success, JSON.stringify(s)).toBe(protocolChatId.safeParse(s).success) },
  )
  it('accept and refuse these', () => {
    for (const ok of ['c', 'chat-1', 'A_b-9', 'x'.repeat(64)]) expect(ChatIdSchema.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['', 'x'.repeat(65), 'chat 1', 'chat.1', 'chat/1', 'é']) expect(ChatIdSchema.safeParse(bad).success, bad).toBe(false)
  })
})

describe('a send (failure 4)', () => {
  const base = { clientTurnKey: 'key-0001', model: 'sonnet' }
  it('takes a text up to 198,000 characters and refuses one more', () => {
    expect(SendTurnInputSchema.safeParse({ ...base, text: 'a'.repeat(198_000) }).success).toBe(true)
    expect(SendTurnInputSchema.safeParse({ ...base, text: 'a'.repeat(198_001) }).success).toBe(false)
  })
  it('counts the quote and the attachment lines in the cap', () => {
    // "> q\n\n" is 5 characters before the text.
    expect(composeTurnPrompt({ text: 'hi', quote: 'q' })).toBe('> q\n\nhi')
    expect(composeTurnPrompt({ text: 'hi', quote: 'a\nb', attachments: [{ fileId: 'f_0123456789abcdefABCDEF', name: 'x.csv' }] }))
      .toBe('> a\n> b\n\nhi\n\nAttached file: inputs/f_0123456789abcdefABCDEF-x.csv')
    expect(SendTurnInputSchema.safeParse({ ...base, quote: 'q', text: 'a'.repeat(197_995) }).success).toBe(true)
    expect(SendTurnInputSchema.safeParse({ ...base, quote: 'q', text: 'a'.repeat(197_996) }).success).toBe(false)
  })
  it('defaults priority and attachments, and refuses a bad key, an empty text or 11 attachments', () => {
    expect(SendTurnInputSchema.parse({ ...base, text: 'x' })).toEqual({ ...base, text: 'x', priority: 'next', attachments: [] })
    expect(SendTurnInputSchema.safeParse({ ...base, clientTurnKey: 'short', text: 'x' }).success).toBe(false)
    expect(SendTurnInputSchema.safeParse({ ...base, text: '' }).success).toBe(false)
    const att = { fileId: 'f_0123456789abcdefABCDEF', name: 'a.pdf' }
    expect(SendTurnInputSchema.safeParse({ ...base, text: 'x', attachments: Array(10).fill(att) }).success).toBe(true)
    expect(SendTurnInputSchema.safeParse({ ...base, text: 'x', attachments: Array(11).fill(att) }).success).toBe(false)
  })
  it('takes an attachment ref only with an f_ id of 22 characters and a 1-200 character name without control characters', () => {
    expect(AttachmentRefSchema.safeParse({ fileId: 'f_0123456789abcdefABCDE', name: 'a' }).success).toBe(false)
    expect(AttachmentRefSchema.safeParse({ fileId: 'f_0123456789abcdefABCDEF', name: '' }).success).toBe(false)
    expect(AttachmentRefSchema.safeParse({ fileId: 'f_0123456789abcdefABCDEF', name: 'n'.repeat(200) }).success).toBe(true)
    expect(AttachmentRefSchema.safeParse({ fileId: 'f_0123456789abcdefABCDEF', name: 'n'.repeat(201) }).success).toBe(false)
    for (const bad of ['a\nb', 'a\u0000', '\t', 'x\u007f', 'x\u0085']) expect(AttachmentRefSchema.safeParse({ fileId: 'f_0123456789abcdefABCDEF', name: bad }).success, JSON.stringify(bad)).toBe(false)
    for (const ok of ['report final.pdf', 'café.csv', 'ü—x.txt']) expect(AttachmentRefSchema.safeParse({ fileId: 'f_0123456789abcdefABCDEF', name: ok }).success, ok).toBe(true)
  })
})

describe('the frame envelope (failure 5)', () => {
  it('parses an unknown version and an unknown event, so the client decides', () => {
    const frame = { v: 7, chatId: 'chat-1', runId, seq: 3, at, event: { type: 'from.the.future', x: 1 } }
    expect(ChatFrameEnvelopeSchema.safeParse(frame).success).toBe(true)
    expect(ChatEventSchema.safeParse(frame.event).success).toBe(false)
    expect(ChatFrameEnvelopeSchema.safeParse({ ...frame, seq: 0 }).success).toBe(false)
  })
})

describe('route 23 and the rest (failure 6)', () => {
  it('takes a chat id by the protocol rule and a 1-200 character title', () => {
    expect(CreateChatInputSchema.safeParse({ id: 'chat-1', title: 't' }).success).toBe(true)
    expect(CreateChatInputSchema.safeParse({ id: 'chat-1', title: 't'.repeat(200) }).success).toBe(true)
    expect(CreateChatInputSchema.safeParse({ id: 'chat-1', title: '' }).success).toBe(false)
    expect(CreateChatInputSchema.safeParse({ id: 'chat-1', title: 't'.repeat(201) }).success).toBe(false)
    expect(CreateChatInputSchema.safeParse({ id: 'chat 1', title: 't' }).success).toBe(false)
  })
  it('lets an Inhouse member (an m_ id) be the one who paused', () => {
    expect(PauseStateSchema.safeParse({ paused: true, at, by: 'm_ih_subject-1' }).success).toBe(true)
    expect(PauseStateSchema.safeParse({ paused: false, at: null, by: null }).success).toBe(true)
  })
  it('stores a message with its turn, run, position and time', () => {
    expect(StoredMessageSchema.safeParse({ id: `${turnId}.u`, role: 'user', text: 'hi', turnId, runId, pos: 0, at }).success).toBe(true)
    expect(StoredMessageSchema.safeParse({ id: `${turnId}.1`, role: 'agent', part: { type: 'text', text: 'ok' }, trace: runId, turnId, runId, pos: 1 }).success).toBe(false)
  })
})
