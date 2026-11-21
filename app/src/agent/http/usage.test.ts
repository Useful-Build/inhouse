// The client's usage reads. Ways they can fail: the wrong path or month parameter, an answer the schema refuses passed
// on, months read in another order (or this month twice), a failure swallowed.
import { describe, expect, test } from 'vitest'
import { AgentError } from '../types'
import { Transport } from './transport'
import { readUsage, readUsageMonths } from './usage'

const usd = (minor: number) => ({ minor, currency: 'USD' })
const month = (monthKey: string, name: string, total: number, months?: string[]) => ({
  month: name, monthKey, cap: usd(1000), alertAt: 80, total: usd(total), conversations: 1, questionsAsked: 2, jobsRun: 0, daily: [usd(total)],
  breakdown: { person: [], job: [], model: [], tool: [] }, capReached: false, alertCrossed: false, ...(months ? { months } : {}),
})

function server(answers: Record<string, { status: number; body: unknown }>) {
  const paths: string[] = []
  const fetch: typeof globalThis.fetch = async input => {
    const path = String(input)
    paths.push(path)
    const a = answers[path] ?? { status: 404, body: { error: { code: 'not_found' } } }
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } })
  }
  return { transport: new Transport({ fetch }), paths }
}

describe('usage reads', () => {
  test('this month, then each earlier month the server lists, newest first', async () => {
    const s = server({
      '/api/usage': { status: 200, body: month('2026-11', 'November', 473, ['2026-11', '2026-10', '2026-09']) },
      '/api/usage?month=2026-10': { status: 200, body: month('2026-10', 'October', 200) },
      '/api/usage?month=2026-09': { status: 200, body: month('2026-09', 'September', 0) },
    })
    const r = await readUsageMonths(s.transport)
    expect(s.paths).toEqual(['/api/usage', '/api/usage?month=2026-10', '/api/usage?month=2026-09'])
    expect(r.usage.total).toEqual(usd(473))
    expect(r.usageMonths.map(m => m.monthKey)).toEqual(['2026-11', '2026-10', '2026-09'])
  })

  test('an answer the schema refuses, or a failure, is an AgentError', async () => {
    const s = server({ '/api/usage': { status: 200, body: { month: 'November' } }, '/api/usage?month=2026-10': { status: 503, body: null } })
    await expect(readUsage(s.transport)).rejects.toMatchObject({ code: 'unknown' })
    await expect(readUsage(s.transport, '2026-10')).rejects.toBeInstanceOf(AgentError)
    await expect(readUsage(s.transport, '2026-10')).rejects.toMatchObject({ code: 'unavailable' })
  })
})
