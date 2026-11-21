// `traceOf` asks the agent for a trace once per id. A message the client made itself (the refusal shown when a send is
// refused, e.g. while the agent is paused) has the empty id, and asking for it sent `GET /api/traces/` (404 and a console error).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function load() {
  vi.resetModules()
  const { agent } = await import('../../agent')
  const { traceOf } = await import('./traces')
  return { agent, traceOf }
}

describe('traceOf', () => {
  it('never asks the agent for the empty id, and says there are no steps', async () => {
    const { agent, traceOf } = await load()
    const ask = vi.spyOn(agent, 'getTrace')
    expect(traceOf('')).toBeNull()
    expect(traceOf('')).toBeNull()
    expect(ask).not.toHaveBeenCalled()
  })
  it('asks once for a real id', async () => {
    const { agent, traceOf } = await load()
    const ask = vi.spyOn(agent, 'getTrace').mockResolvedValue(null)
    expect(traceOf('t_AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined()
    expect(traceOf('t_AAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined()
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith('t_AAAAAAAAAAAAAAAAAAAAAA')
  })
})
