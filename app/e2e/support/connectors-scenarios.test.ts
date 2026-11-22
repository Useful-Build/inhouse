// The connector ship scenarios (test/scripted-model/scenarios.ts): each exists, ends in a text answer, and the code mode one calls the
// hub's script tool with the script the scenarios file holds. (That script is a copy of the measured one: the hub's own test,
// hub/codemode/measure/scenario-script.test.ts, fails when they drift.)
import { describe, expect, it } from 'vitest'
import { CODE_MODE_SCRIPT, SCENARIOS } from '../../test/scripted-model/scenarios.ts'

describe('the connector ship scenarios', () => {
  it('the code mode scenario calls the script tool with the scenarios file\'s script', () => {
    const call = (SCENARIOS['connectors-codemode']!.turns[0]!.content as { name?: string; input?: { code?: string } }[])[0]!
    expect(call.name).toBe('mcp__apps__shopify_script_run')
    expect(call.input?.code).toBe(CODE_MODE_SCRIPT)
  })

  it('every connector scenario exists and ends in a text answer', () => {
    for (const name of ['connectors', 'connectors-supplier', 'connectors-codemode', 'connectors-notice', 'connectors-notice-unlisted']) {
      const turns = SCENARIOS[name]?.turns
      expect(turns, name).toBeDefined()
      expect((turns!.at(-1)!.content as { type: string }[])[0]!.type).toBe('text')
    }
  })
})
