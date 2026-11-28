// The request schemas and the error body. Ways they can fail, written down first:
//  1. a value the client sends (an effort, a priority, a stage) outside its enum parses, so the server takes it;
//  2. an error body the Worker writes (a code, a reason, the current record) doesn't parse for the client, or one with an unknown code does;
//  3. a missing required field (a chat id) parses.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentErrorCodeSchema, AskOptionsSchema, CreateChatInputSchema, DemoContextSchema, ErrorBodySchema, ErrorReasonSchema, ResourceKeySchema, SendOptionsSchema, SendPrioritySchema } from './index.ts'

describe('request schemas', () => {
  it('parse what the client sends', () => {
    expect(AskOptionsSchema.parse({ chatId: 'c1', quote: 'q', replacesRun: 'r1', attachments: [{ name: 'a.csv', meta: '1 KB', icon: 'description' }], mode: 'sonnet', effort: 'high' }).effort).toBe('high')
    expect(SendOptionsSchema.parse({ priority: 'now' }).priority).toBe('now')
    expect(DemoContextSchema.parse({ scenario: 'Normal' })).toEqual({ scenario: 'Normal' })
    expect(DemoContextSchema.parse({ scenario: 'Normal', viewAs: 'member' })).toEqual({ scenario: 'Normal', viewAs: 'member' })
    expect(CreateChatInputSchema.parse({ id: 'chat-1', title: 'A chat' }).id).toBe('chat-1')
  })
  it('refuse a value outside its enum, and a missing chat', () => {
    expect(AskOptionsSchema.safeParse({ chatId: 'c1', effort: 'extreme' }).success).toBe(false)
    expect(AskOptionsSchema.safeParse({}).success).toBe(false)
    expect(SendPrioritySchema.safeParse('urgent').success).toBe(false)
    expect(DemoContextSchema.safeParse({ scenario: 'Fly' }).success).toBe(false)
    expect(DemoContextSchema.safeParse({ scenario: 'Normal', viewAs: 'owner' }).success).toBe(false)
    expect(CreateChatInputSchema.safeParse({ id: '', title: 'x' }).success).toBe(false)
  })
})

describe('the error body', () => {
  it('parses every code and reason, with the current record', () => {
    for (const code of AgentErrorCodeSchema.options) expect(ErrorBodySchema.safeParse({ error: { code } }).success, code).toBe(true)
    for (const reason of ErrorReasonSchema.options) expect(ErrorBodySchema.safeParse({ error: { code: 'forbidden', reason } }).success, reason).toBe(true)
    expect(ErrorBodySchema.parse({ error: { code: 'conflict', current: { id: 'm_x', rev: 3 } } }).error.current).toEqual({ id: 'm_x', rev: 3 })
  })
  it('refuses an unknown code or reason, and a body with no error', () => {
    expect(ErrorBodySchema.safeParse({ error: { code: 'teapot' } }).success).toBe(false)
    expect(ErrorBodySchema.safeParse({ error: { code: 'conflict', reason: 'because' } }).success).toBe(false)
    expect(ErrorBodySchema.safeParse({ code: 'conflict' }).success).toBe(false)
  })
  it('has the four codes P2 adds, and a resource key for each list', () => {
    expect(AgentErrorCodeSchema.options).toEqual(expect.arrayContaining(['unauthorized', 'rate_limited', 'cap_reached', 'invalid']))
    expect(ResourceKeySchema.options).toEqual(expect.arrayContaining(['members', 'audit']))
  })
})

describe('zod code generation', () => {
  // The product's CSP has no `unsafe-eval`: zod 4 probes `new Function` when an object schema is built unless jitless is set (jitless.ts).
  it('is off once jitless.ts has run', async () => {
    await import('./jitless.ts')
    expect(z.config().jitless).toBe(true)
  })
})
