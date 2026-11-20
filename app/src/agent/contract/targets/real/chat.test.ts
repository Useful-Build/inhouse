import { describe, expect, it } from 'vitest'
import { CHAT_EXEMPT, CHAT_READ_PATH, forgetRoute, usagePath } from './chat'
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
