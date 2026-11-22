// A routine run's trace in the eval build (A9's pre-squash ask, p3-eval-observability rev 2 rec 5): route 33 admits a
// routine run for any person through its `m_system` fallback (`getTrace(id, { owner: 'm_system' })`, server/api/runs.ts),
// and in the eval build that owner scope carries a tool step's kept input. Intended: the person sees it (a routine's
// steps are the team's, BD11). Ways it can fail, written down first: the fallback's scope drops the input; the person's
// own scope already shows the routine's trace (no fallback needed, the rule untested); Inhouse's `all` scope shows it.
import { describe, expect, it } from 'vitest'
import type { SendTurnResult } from '../../shared/contract/runs.ts'
import type { Refusal } from '../do/brand-agent/ports.ts'
import { MEMBER, SEC, T0, ev, fullAnswer, inAgent, settle } from '../testing/brand-agent/core-harness.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}

describe('a routine run\'s trace in the eval build', () => {
  it('the m_system scope route 33 falls back to shows the tool step\'s input; a person\'s own scope misses the run; Inhouse sees no input', () => inAgent(async h => {
    // A routine's turn, as the tick submits it: the routine principal, in its own chat.
    const a = ok(await h.core.submitTurn({
      chatId: 'rc_evaltrace', by: { kind: 'service', memberId: 'm_system' }, model: 'claude-sonnet-5-5', pickerId: 'sonnet', effort: 'medium',
      sideModel: 'claude-haiku-5-5', maxTurns: 25, webFetchDomains: null,
      input: { clientTurnKey: 'rs_evaltrace0001', text: 'Check the stock levels.', priority: 'next', model: 'sonnet', attachments: [] },
    }))
    await settle()
    h.clock.now = T0 + 1 * SEC
    h.push(a.turnId, ev.started(), ev.tool('WebFetch'))
    // The input as the runner sends it, in capInput's wrapper (runner/src/guards/audit.ts; eval-trace/on.ts toolInput).
    await h.core.writeToolCall(a.turnId, 0, { hook: 'PreToolUse', toolName: 'WebFetch', toolUseId: 'tu_1', decision: 'allow', input: { cut: false, value: { url: 'https://shop.example.test/stock' } } })
    h.clock.now = T0 + 3 * SEC
    h.push(a.turnId, ...fullAnswer('done', 2))
    await settle()
    const input = '{"url":"https://shop.example.test/stock"}'
    for (const id of [a.turnId, a.runId]) {
      // The person's own scope doesn't reach a routine's run: route 33 needs its fallback.
      expect(h.core.readTrace(id, { owner: MEMBER }), id).toBeNull()
      // The fallback's scope: the input shows on the tool step.
      expect(h.core.readTrace(id, { owner: 'm_system' })?.steps.find(s => s.kind === 'tool')?.io, id).toEqual({ input })
      // Inhouse's all scope: never an input (BD7).
      expect(JSON.stringify(h.core.readTrace(id, { all: true })), id).not.toContain('shop.example.test')
    }
  }, { evalTrace: true }))
})
