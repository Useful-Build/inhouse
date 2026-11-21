import { describe, expect, it } from 'vitest'
import { MEMORY_SAVE_TEXT } from '../../../../../test/scripted-model/scenarios'
import { CHAT_EXEMPT, CHAT_READ_PATH, CHAT_SERVED, chatRoute, forgetRoute, freshChat, seedMemoryFact, SEEDED_MEMORY_TEXT, usagePath } from './chat'
import type { Signer } from './me'

const KEY_B = 'mem_AAAAAAAAAAAAAAAAAAAAAA'
const KEY_P = 'mem_BBBBBBBBBBBBBBBBBBBBBB'
const line = (key: string) => ({ key, text: 't', source: 's', rev: 1 })
const page = { team: [{ group: 'Shared with the team', lines: [line(KEY_B)] }], personal: [line(KEY_P)] }
const signer = (status: number, json: unknown): Signer => ({ api: async () => ({ status, json }) }) as unknown as Signer

describe('the real target\'s memory and usage parts', () => {
  it('reads the pages from the routes\' paths (literal)', () => {
    expect(CHAT_READ_PATH).toEqual({ memory: '/api/memory', usage: '/api/usage' })
    expect(usagePath()).toBe('/api/usage')
    expect(usagePath('2026-03')).toBe('/api/usage?month=2026-03')
  })
  it('exempts forgetMemory with a reason that names the later PR', () => {
    expect(Object.keys(CHAT_EXEMPT)).toEqual(['forgetMemory'])
    expect(CHAT_EXEMPT.forgetMemory).toMatch(/no route creates a memory fact.*W7 PR 2.*no local D1/)
  })
  it('sends a team line to route 45 and a person\'s own to route 44', async () => {
    expect(await forgetRoute(signer(200, page), 'admin', KEY_B)).toEqual({ verbs: ['PUT'], path: `/api/memory/brand/${KEY_B}/forgotten` })
    expect(await forgetRoute(signer(200, page), 'dana', KEY_P)).toEqual({ verbs: ['PUT'], path: `/api/memory/personal/${KEY_P}/forgotten` })
  })
  it('fails loud on an unknown line or an unreadable page', async () => {
    await expect(forgetRoute(signer(200, page), 'dana', 'mem_CCCCCCCCCCCCCCCCCCCCCC')).rejects.toThrow(/no memory line/)
    await expect(forgetRoute(signer(503, null), 'dana', KEY_P)).rejects.toThrow(/503/)
  })
})

describe('the real target\'s chat and pause parts (W7 PR 2)', () => {
  it('serves exactly these methods (literal)', () => {
    expect([...CHAT_SERVED]).toEqual(['createChat', 'renameChat', 'pinChat', 'deleteChats', 'restoreChats', 'pause', 'resume'])
  })
  it('sends each write to the route the design numbers (literal paths and verbs; the id is URL-encoded)', () => {
    expect(chatRoute('createChat', [{ id: 'c1', title: 't' }])).toEqual({ verbs: ['POST'], path: '/api/chats' })
    expect(chatRoute('renameChat', ['a b/c', 'x'])).toEqual({ verbs: ['PUT'], path: '/api/chats/a%20b%2Fc/title' })
    expect(chatRoute('pinChat', ['c1', true])).toEqual({ verbs: ['PUT'], path: '/api/chats/c1/pin' })
    expect(chatRoute('deleteChats', [['c1']])).toEqual({ verbs: ['POST'], path: '/api/chats/delete' })
    expect(chatRoute('restoreChats', [['c1']])).toEqual({ verbs: ['POST'], path: '/api/chats/restore' })
    expect(chatRoute('pause', [])).toEqual({ verbs: ['POST'], path: '/api/pause' })
    expect(chatRoute('resume', [])).toEqual({ verbs: ['POST'], path: '/api/resume' })
    expect(chatRoute('setSetting', ['k', 'v'])).toBeNull()
  })
  it('gives every reset its own chat id, one the API accepts', () => {
    const ids = [1, 2, 3].map(n => freshChat(n, 'abc123').id)
    expect(ids).toEqual(['contract-chat-abc123-1', 'contract-chat-abc123-2', 'contract-chat-abc123-3'])
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })
  it('the seeded memory text is the one the scripted scenario saves (imported from that file)', () => {
    expect(SEEDED_MEMORY_TEXT).toBe(MEMORY_SAVE_TEXT)
  })
  it('seeds a memory line with a scripted turn and returns the key of the person\'s own line', async () => {
    const calls: string[] = []
    let reads = 0
    const s = { api: async (_w: string, method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}`)
      if (path === '/api/memory') return { status: 200, json: ++reads < 3 ? { team: [], personal: [] } : { team: [], personal: [{ key: KEY_P, text: SEEDED_MEMORY_TEXT, source: 's', rev: 1 }] } }
      if (path.endsWith('/turns')) expect(body).toMatchObject({ text: 'scenario:memory-save remember this', model: 'sonnet' })
      return { status: path.endsWith('/turns') ? 202 : 200, json: {} }
    } } as unknown as Signer
    expect(await seedMemoryFact(s, 'admin', { chatId: 'seed-1', sleep: async () => {} })).toBe(KEY_P)
    expect(calls).toEqual(['GET /api/memory', 'POST /api/chats', 'POST /api/chats/seed-1/turns', 'GET /api/memory', 'GET /api/memory'])
  })
  it('ignores a line with the seeded text that was there before the send', async () => {
    const old = { key: KEY_B, text: SEEDED_MEMORY_TEXT, source: 's', rev: 1 }
    const fresh = { key: KEY_P, text: SEEDED_MEMORY_TEXT, source: 's', rev: 1 }
    let reads = 0
    const s = { api: async (_w: string, _m: string, path: string) => (path === '/api/memory' ? { status: 200, json: { team: [], personal: ++reads < 3 ? [old] : [old, fresh] } } : { status: path.endsWith('/turns') ? 202 : 200, json: {} }) } as unknown as Signer
    expect(await seedMemoryFact(s, 'admin', { chatId: 'seed-4', sleep: async () => {} })).toBe(KEY_P)
  })
  it('fails loud when the turn makes no line in time or a call is refused', async () => {
    const quiet = { api: async (_w: string, _m: string, path: string) => ({ status: path.endsWith('/turns') ? 202 : 200, json: { team: [], personal: [] } }) } as unknown as Signer
    await expect(seedMemoryFact(quiet, 'admin', { chatId: 'seed-2', timeoutMs: -1, sleep: async () => {} })).rejects.toThrow(/no memory line in time/)
    await expect(seedMemoryFact(signer(503, null), 'admin', { chatId: 'seed-3' })).rejects.toThrow(/503/)
  })
})
