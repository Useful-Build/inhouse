// The Activity sheet's "How your agent worked it out". Ways it could fail, written down first:
//  1. a mechanic leaks into a sentence: a model's id, a timing, a bracketed reason, the run's root line;
//  2. a tool step reads as a label, not a sentence ("Shopify · orders" as is), or a write reads as a look;
//  3. a live product label stays in the present tense ("Searching memory");
//  4. every recorded demo trace gives at least one sentence, each one capitalised and ending on a full stop.
import { describe, expect, test } from 'vitest'
import type { Trace, TraceStep } from '../../agent/types'
import traces from '../../agent/sample-data/traces.json'
import { plainSteps, sentence } from './plain-steps'

const step = (label: string, kind: TraceStep['kind'], detail = ''): TraceStep => ({ label, kind, startMs: 0, endMs: 1200, depth: 1, detail })
const run = (...steps: TraceStep[]): Trace => ({ id: 't', title: 'A run', durationMs: 1200, cost: { minor: 4, currency: 'USD' }, tokens: '1.2k', steps: [step('Inhouse agent', 'root'), ...steps] })

describe('plain steps', () => {
  test('no root, no model id, no bracketed reason, no bare Answer (failure 1)', () => {
    expect(plainSteps(run(step('claude-sonnet-5-5', 'model', '120 in · 40 out'), step('Waiting for ShipBob (rate limit)', 'wait'), step('Answer', 'answer'))))
      .toEqual(['Waited for ShipBob.'])
  })
  test('tool steps read as sentences; a write says what it did (failure 2)', () => {
    expect(plainSteps(run(
      step('Shopify · orders, stock, returns', 'tool'),
      step('Library · saved the report', 'tool'),
      step('Memory · how your team wants it done', 'tool'),
      step('Your tools · the numbers behind the problem', 'tool'),
      step('Kestrel price list', 'tool'),
      step('PO sheet · Kestrel lead time', 'tool'),
      step('Hand off to the routine builder', 'handoff'),
      step('Worked out the fix', 'model'),
    ))).toEqual([
      'Looked at orders, stock, returns in Shopify.',
      'Saved the report in Library.',
      'Remembered how your team wants it done.',
      'Looked at the numbers behind the problem in your tools.',
      'Looked at Kestrel price list.',
      'Looked at Kestrel lead time in PO sheet.',
      'Handed off to the routine builder.',
      'Worked out the fix.',
    ])
  })
  test('a product label is said in the past, and a repeat of the line before is dropped (failure 3)', () => {
    expect(plainSteps(run(step('Searching memory', 'tool'), step('Using a tool', 'tool'), step('Using a tool', 'tool'))))
      .toEqual(['Searched memory.', 'Used a tool.'])
  })
  test('every demo trace gives plain sentences with no mechanics (failure 4)', () => {
    // The recorded file keeps seconds, not the contract's ms: only each step's label and kind matter here.
    for (const [key, t] of Object.entries(traces.traces)) {
      const lines = plainSteps({ ...run(), steps: t.steps.map(s => step(s.label, s.kind as TraceStep['kind'])) })
      expect(lines.length, key).toBeGreaterThan(0)
      for (const l of lines) {
        expect(l, key).toMatch(/^[A-Z0-9#].*[.!?]$/)
        expect(l, key).not.toMatch(/\b(Haiku|Sonnet|Opus|tokens?|trace)\b|\d+(\.\d+)?\s?(ms|s)\b| · /)
      }
    }
  })
  test('a sentence gets one full stop and a capital', () => {
    expect([sentence('it ran'), sentence('It ran.'), sentence('Did it?'), sentence('  ')]).toEqual(['It ran.', 'It ran.', 'Did it?', ''])
  })
})
