// What a step row says. Ways it can fail: a read that starts with a write verb ("sent mail") loses "Checked", a real
// write ("saved the report") counts as a read, or two sources get the same read.
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import type { AgentData, MessagePart, Trace, TraceStep, TraceStepKind } from '../../agent/types'
import { ICON_NAMES } from '../../ui/icon-manifest'
import { KIND_ICON, mapLiveStepsToTraceRows, mapTraceToTraceRows, sourcesOf, stepRows, type TraceLiveOutcome, type TraceRow } from './step-data'

const data = { tools: { details: { klaviyo: { name: 'Klaviyo' }, gmail: { name: 'Gmail' }, library: { name: 'Library' }, shopify: { name: 'Shopify' }, shipbob: { name: 'ShipBob' } } } } as unknown as AgentData
const step = (label: string, startMs = 0, endMs = 100, kind: TraceStepKind = 'tool', depth = 1, detail = ''): TraceStep => ({ label, kind, startMs, endMs, depth, detail })
const trace = (...labels: string[]): Trace => ({ id: 't', title: '', durationMs: 1, cost: {} as Trace['cost'], tokens: '', steps: labels.map(l => step(l)) })
const flatten = (rows: readonly TraceRow[]): TraceRow[] => rows.flatMap(r => [r, ...flatten(r.children)])
const checkDepthOrder = (rows: readonly TraceRow[]) => {
  for (const r of rows) {
    for (const c of r.children) expect(c.depth).toBeGreaterThan(r.depth)
    checkDepthOrder(r.children)
  }
}

describe('stepRows', () => {
  test.each([
    ['Klaviyo · sent campaigns, last 30 days', true],
    ['Gmail · sent mail', true],
    ['Library · saved the report', false],
    ['Library · saved a chart', false],
    ['Gmail · drafted a reply to Sam', false],
    ['Gmail · sent email to Sam', false],
    ['Shopify · created draft order #12', false],
    ['Library · saved notes', false],
    ['Library · sent the weekly report, this morning', false],
    ['Shopify · updated orders, this week', true],
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

describe('mapLiveStepsToTraceRows', () => {
  const live = [
    { id: '1', label: 'Reading Shopify orders…', tool: 'Shopify' },
    { id: '2', label: 'Checking ShipBob shipments…' },
    { id: '3', label: 'Writing the answer…' },
  ]
  test('marks earlier steps done, latest running, and matches connected tool logos', () => {
    const rows = mapLiveStepsToTraceRows(data, live)
    expect(rows.map(r => [r.status, r.tool, r.icon])).toEqual([
      ['done', 'shopify', 'check'],
      ['done', 'shipbob', 'check'],
      ['running', null, 'progress_activity'],
    ])
  })
  test('marks the last row error when failed, and clears running on stopped/interrupted/cancelled', () => {
    const failed = mapLiveStepsToTraceRows(data, live, { outcome: 'failed' })
    expect(failed.map(r => r.status)).toEqual(['done', 'done', 'error'])
    expect(failed[2].icon).toBe('error')
    for (const outcome of ['stopped', 'interrupted', 'cancelled', 'done'] as const) {
      const rows = mapLiveStepsToTraceRows(data, live, { outcome })
      expect(rows.every(r => r.status === 'done'), outcome).toBe(true)
    }
  })
})

describe('mapTraceToTraceRows', () => {
  const sample: Trace = {
    id: 'run-1',
    title: 'Stuck orders',
    durationMs: 10_000,
    cost: { minor: 4, currency: 'USD' },
    tokens: '12k',
    steps: [
      step('Inhouse agent', 0, 10_000, 'root', 0, 'Chats'),
      step('Shopify · paid orders', 0, 2000, 'tool', 1, 'Input: unfulfilled'),
      step('Routine builder · set up check', 2000, 8000, 'agent', 1, 'Setup'),
      step('Waiting for ShipBob', 3000, 5000, 'wait', 2, 'Rate limit'),
      step('Message waits for approval', 8000, 9000, 'approval', 1, 'Paused'),
      step('Gorgias · failed login', 9000, 10_000, 'fail', 1, '401'),
    ],
  }

  test('maps kinds, connected tools, nesting from depth, and slowest', () => {
    const rows = mapTraceToTraceRows(data, sample)
    expect(rows).toHaveLength(1)
    expect(rows[0].children).toHaveLength(4)
    expect(rows[0].children[0]).toMatchObject({ tool: 'shopify', title: 'Paid orders', status: 'done' })
    expect(rows[0].children[1]).toMatchObject({ icon: 'account_tree', slowest: true })
    expect(rows[0].children[1].children[0]).toMatchObject({ icon: 'hourglass_empty', depth: 2, status: 'done' })
    expect(rows[0].children[2]).toMatchObject({ status: 'pending', icon: 'front_hand' })
    expect(rows[0].children[3]).toMatchObject({ status: 'error', icon: 'error' })
  })

  test('maps replay time t to pending, running, or finished status', () => {
    const flat = flatten(mapTraceToTraceRows(data, sample, { t: 4000 }))
    expect(flat.map(r => r.status)).toEqual(['running', 'done', 'running', 'running', 'pending', 'pending'])
  })

  test('every kind icon exists in ICON_NAMES', () => {
    const known = new Set<string>(ICON_NAMES)
    for (const icon of Object.values(KIND_ICON)) expect(known.has(icon)).toBe(true)
  })
})

describe('trace mapper properties', () => {
  const outcomes: TraceLiveOutcome[] = ['running', 'done', 'failed', 'stopped', 'interrupted', 'cancelled']
  const kinds: TraceStepKind[] = ['root', 'model', 'tool', 'agent', 'wait', 'handoff', 'approval', 'answer', 'fail']

  test('live steps: every step appears once, depth order holds, at most one running', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 1, maxLength: 8 }),
            label: fc.string({ minLength: 1, maxLength: 40 }),
            depth: fc.integer({ min: 0, max: 5 }),
          }),
          { maxLength: 20 },
        ),
        fc.constantFrom(...outcomes),
        (steps, outcome) => {
          const tree = mapLiveStepsToTraceRows(data, steps, { outcome })
          const flat = flatten(tree)
          expect(flat).toHaveLength(steps.length)
          expect(flat.map(r => r.label)).toEqual(steps.map(s => s.label))
          checkDepthOrder(tree)
          expect(flat.filter(r => r.status === 'running').length).toBeLessThanOrEqual(1)
        },
      ),
    )
  })

  test('finished trace: every step appears once, depth order holds, no running when not replaying', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            label: fc.string({ minLength: 1, maxLength: 40 }),
            kind: fc.constantFrom(...kinds),
            startMs: fc.integer({ min: 0, max: 10_000 }),
            spanMs: fc.integer({ min: 0, max: 5_000 }),
            depth: fc.integer({ min: 0, max: 5 }),
            detail: fc.string({ maxLength: 40 }),
          }),
          { maxLength: 25 },
        ),
        steps => {
          const input: Trace = {
            id: 'prop',
            title: 'Prop',
            durationMs: 15_000,
            cost: { minor: 0, currency: 'USD' },
            tokens: '0',
            steps: steps.map(s => ({ label: s.label, kind: s.kind, startMs: s.startMs, endMs: s.startMs + s.spanMs, depth: s.depth, detail: s.detail })),
          }
          const tree = mapTraceToTraceRows(data, input)
          const flat = flatten(tree)
          expect(flat).toHaveLength(input.steps.length)
          expect(flat.map(r => r.label)).toEqual(input.steps.map(s => s.label))
          checkDepthOrder(tree)
          expect(flat.filter(r => r.status === 'running').length).toBeLessThanOrEqual(1)
        },
      ),
    )
  })
})
