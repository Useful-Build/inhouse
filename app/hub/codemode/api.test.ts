// ScriptApi, the one object a script reaches (P5 W2, A.3 and A.7.6/8). Failure modes:
// - an 11th call, or a read past 4 MiB in all, reaches the upstream or returns data;
// - two calls in flight at once (Promise.all pulls many responses into hub memory);
// - a call after close (run settled or deadline) reaches the client, queued or new; a late answer is returned;
// - a refusal carries upstream text instead of the fixed HubError message;
// - a non-string query or non-plain variables reach the client.
import fc from 'fast-check'
import { test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'
import { BYTES_MESSAGE, CALLS_MESSAGE, CLOSED_MESSAGE, ScriptApi, type ScriptClient } from './api'
import { MAX_CALLS, MAX_READ_BYTES } from './caps'
import type { HubResult } from '../index/contract'

type Pending = { document: string; resolve: (r: HubResult<{ data: unknown }>) => void }

/** A client whose answers the test releases by hand, recording how many are in flight. */
class HandClient implements ScriptClient {
  seen: { document: string; apiVersion?: string }[] = []
  pending: Pending[] = []
  inFlight = 0
  maxInFlight = 0
  graphql(document: string, _variables?: Record<string, unknown>, apiVersion?: string): Promise<HubResult<{ data: unknown }>> {
    this.seen.push({ document, apiVersion })
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    return new Promise(resolve => {
      this.pending.push({
        document,
        resolve: r => {
          this.inFlight--
          resolve(r)
        },
      })
    })
  }
}

/** Answers at once with `data`. */
const instant = (data: (i: number) => unknown): ScriptClient & { calls: number } => {
  const c = {
    calls: 0,
    async graphql() {
      return { ok: true as const, value: { data: data(c.calls++) } }
    },
  }
  return c
}

const tick = () => new Promise<void>(r => queueMicrotask(r))
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await tick()
}

describe('ScriptApi', () => {
  it('sends the pinned API version and returns { data }', async () => {
    const c = new HandClient()
    const api = new ScriptApi(c, '2026-10')
    const p = api.graphql('{ shop { currencyCode } }', { a: 1 })
    await settle()
    c.pending[0]!.resolve({ ok: true, value: { data: { shop: { currencyCode: 'USD' } } } })
    expect(await p).toEqual({ data: { shop: { currencyCode: 'USD' } } })
    expect(c.seen).toEqual([{ document: '{ shop { currencyCode } }', apiVersion: '2026-10' }])
  })

  it('the 11th call throws without reaching the client', async () => {
    const c = instant(() => ({ n: 1 }))
    const api = new ScriptApi(c, '2026-10')
    for (let i = 0; i < MAX_CALLS; i++) await api.graphql('{ a }')
    await expect(api.graphql('{ a }')).rejects.toThrow(CALLS_MESSAGE)
    expect(c.calls).toBe(MAX_CALLS)
  })

  it('reading 4 MiB + 1 byte in all throws on the call that crosses', async () => {
    // JSON of a string of n characters is n + 2 bytes.
    const half = MAX_READ_BYTES / 2 - 2
    // Two strings fill the budget exactly; the third answer, `0`, is one byte more.
    const c = instant(i => (i < 2 ? 'x'.repeat(half) : 0))
    const api = new ScriptApi(c, '2026-10')
    await api.graphql('{ a }')
    await api.graphql('{ a }')
    expect(api.bytes).toBe(MAX_READ_BYTES)
    await expect(api.graphql('{ a }')).rejects.toThrow(BYTES_MESSAGE)
  })

  test.prop([fc.integer({ min: 2, max: MAX_CALLS }), fc.array(fc.nat(), { minLength: MAX_CALLS, maxLength: MAX_CALLS })])(
    'Promise.all over n calls: never two in flight, answered in call order',
    async (n, order) => {
      const c = new HandClient()
      const api = new ScriptApi(c, '2026-10')
      const all = Promise.all(Array.from({ length: n }, (_, i) => api.graphql(`{ q${i} }`)))
      for (let i = 0; i < n; i++) {
        await settle()
        expect(c.pending.length).toBe(1)
        c.pending.shift()!.resolve({ ok: true, value: { data: order[i] } })
      }
      expect((await all).map(r => r.data)).toEqual(order.slice(0, n))
      expect(c.maxInFlight).toBe(1)
      expect(c.seen.map(s => s.document)).toEqual(Array.from({ length: n }, (_, i) => `{ q${i} }`))
    },
  )

  it('after close, queued and new calls are refused without reaching the client; a late answer is dropped', async () => {
    const c = new HandClient()
    let refused = 0
    const api = new ScriptApi(c, '2026-10', { refused: () => refused++ })
    const first = api.graphql('{ one }')
    const queued = api.graphql('{ two }')
    await settle()
    api.close()
    c.pending[0]!.resolve({ ok: true, value: { data: 'late' } })
    await expect(first).rejects.toThrow(CLOSED_MESSAGE)
    await expect(queued).rejects.toThrow(CLOSED_MESSAGE)
    await expect(api.graphql('{ three }')).rejects.toThrow(CLOSED_MESSAGE)
    expect(c.seen.map(s => s.document)).toEqual(['{ one }'])
    expect(refused).toBe(3)
  })

  it('a failure is the fixed HubError text for its code; field not allowed is kept', async () => {
    const answers: HubResult<{ data: unknown }>[] = [
      { ok: false, error: { code: 'upstream_rejected', message: 'upstream rejected the request: ACCESS_DENIED secret body' } },
      { ok: false, error: { code: 'invalid_args', message: 'invalid arguments: field not allowed' } },
      { ok: false, error: { code: 'invalid_args', message: 'invalid arguments: something else' } },
      { ok: false, error: { code: 'write_refused', message: 'writes are refused' } },
    ]
    const c = { i: 0, async graphql() { return answers[c.i++]! } }
    const api = new ScriptApi(c, '2026-10')
    await expect(api.graphql('{ a }')).rejects.toThrow(/^upstream_rejected: upstream rejected the request$/)
    await expect(api.graphql('{ a }')).rejects.toThrow(/^invalid_args: invalid arguments: field not allowed$/)
    await expect(api.graphql('{ a }')).rejects.toThrow(/^invalid_args: invalid arguments$/)
    await expect(api.graphql('{ a }')).rejects.toThrow(/^write_refused: writes are refused$/)
  })

  it('a non-string query or non-plain variables never reach the client', async () => {
    const c = instant(() => null)
    const api = new ScriptApi(c, '2026-10')
    await expect(api.graphql(42)).rejects.toThrow(/invalid_args/)
    await expect(api.graphql('{ a }', [1])).rejects.toThrow(/invalid_args/)
    await expect(api.graphql('{ a }', new Date())).rejects.toThrow(/invalid_args/)
    await expect(api.graphql('{ a }', 'x')).rejects.toThrow(/invalid_args/)
    expect(c.calls).toBe(0)
  })
})
