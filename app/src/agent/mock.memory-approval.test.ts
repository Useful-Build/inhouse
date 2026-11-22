// The mock's team memory approval (P6a W2). Ways it can fail, written down first:
//  1. someone without `approveMemory` reads the list, or decides a fact (the server refuses both);
//  2. a saved `server.memoryWaiting` isn't read (so specs can't seed waiting facts through the saved state), or an
//     unreadable entry is kept;
//  3. an approved fact doesn't join the team's memory, or a rejected one does.
import { describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
})
const { MockAgent, ME_ID } = await import('./mock')

const STATE_KEY = 'inhouse.demo.v2'
const line = (n: number, text: string) => ({ key: `mem_mockWaiting${String(n).padStart(11, '0')}`, text, source: 'Priya told your Inhouse agent in a chat', rev: 1, scope: 'brand' })
const load = (server: Record<string, unknown>) => {
  store.set(STATE_KEY, JSON.stringify({ server }))
  return new MockAgent()
}
const errorOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e)
const teamTexts = (a: InstanceType<typeof MockAgent>) => a.read().memory.team.flatMap(g => g.lines.map(l => l.text))

describe('the mock: team memory approval', () => {
  it('reads waiting facts from the saved server (newest first), dropping unreadable ones', async () => {
    const a = load({ memoryWaiting: [line(1, 'Kestrel wants PDFs'), { key: 'bad' }, line(2, 'Ship by courier')] })
    expect((await a.waitingMemory()).map(f => [f.text, f.waiting, f.kind])).toEqual([['Ship by courier', true, 'memory'], ['Kestrel wants PDFs', true, 'memory']])
  })
  it('approve joins the team memory; reject does not; both leave the list', async () => {
    const a = load({ memoryWaiting: [line(1, 'Kestrel wants PDFs'), line(2, 'Ship by courier')] })
    await a.waitingMemory()
    await a.reviewMemory(line(1, '').key, true)
    await a.reviewMemory(line(2, '').key, false)
    expect(teamTexts(a)).toContain('Kestrel wants PDFs')
    expect(teamTexts(a)).not.toContain('Ship by courier')
    expect(await a.waitingMemory()).toEqual([])
  })
  it('someone without approveMemory is refused the list and a decision, and nothing moves', async () => {
    const a = load({ roles: { [ME_ID]: 'member' }, memoryWaiting: [line(1, 'Kestrel wants PDFs')] })
    expect(a.me()?.can.approveMemory).toBe(false)
    expect(await errorOf(a.waitingMemory())).toMatchObject({ code: 'forbidden', message: 'Only admins and the Inhouse team can see what waits for an OK.' })
    expect(await errorOf(a.reviewMemory(line(1, '').key, true))).toMatchObject({ code: 'forbidden' })
    expect(teamTexts(a)).not.toContain('Kestrel wants PDFs')
    const admin = load({ memoryWaiting: [line(1, 'Kestrel wants PDFs')] })
    expect((await admin.waitingMemory()).map(f => f.text)).toEqual(['Kestrel wants PDFs'])
  })
})
