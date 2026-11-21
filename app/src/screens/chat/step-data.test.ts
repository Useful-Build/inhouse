// What a step row says. Ways it can fail: a read that starts with a write verb ("sent mail") loses "Checked", a real
// write ("saved the report") counts as a read, or two sources get the same read.
import { describe, expect, test } from 'vitest'
import type { AgentData, MessagePart, Trace } from '../../agent/types'
import { sourcesOf, stepRows } from './step-data'

const data = { tools: { details: { klaviyo: { name: 'Klaviyo' }, gmail: { name: 'Gmail' }, library: { name: 'Library' }, shopify: { name: 'Shopify' } } } } as unknown as AgentData
const step = (label: string, startMs = 0, endMs = 100) => ({ label, kind: 'tool' as const, startMs, endMs, depth: 1, detail: '' })
const trace = (...labels: string[]): Trace => ({ id: 't', title: '', durationMs: 1, cost: {} as Trace['cost'], tokens: '', steps: labels.map(l => step(l)) })

describe('stepRows', () => {
  test.each([
    ['Klaviyo · sent campaigns, last 30 days', true],
    ['Gmail · sent mail', true],
    ['Library · saved the report', false],
    ['Library · saved a chart', false],
    ['Gmail · drafted a reply to Sam', false],
  ])('%s reads: %s', (label, read) => {
    expect(stepRows(data, trace(label))[0].read).toBe(read)
  })
})

describe('sourcesOf', () => {
  test('two sources never take the same read', () => {
    const table = (sources: string[]): MessagePart => ({ type: 'table', table: { title: '', summary: '', rows: [], sources } })
    const t = trace('Shopify · Orders from last week', 'Shopify · Orders from this month')
    const out = sourcesOf(data, [table(['Shopify · Orders', 'Shopify · Orders again'])], t)
    expect(out.map(s => s.read)).toEqual(['Orders from last week', 'Orders from this month'])
  })
})
