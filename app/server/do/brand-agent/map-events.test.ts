// The outcome map and the SDK mapping (p3-design 2 and 4.5) against literal fixtures: SDK result shapes as the runner
// forwards them (`finished` from the SDK's `result` message) and assistant messages. Ways it can fail:
//  1. an error result reads as done, or a success after our interrupt as done;
//  2. `interrupted` is reported when we never asked for it;
//  3. a subagent's text becomes part of the answer; a tool call isn't a step; a truncated message is mapped.
import { describe, expect, it } from 'vitest'
import { mapSdkMessage, outcomeOf } from './map-events.ts'

const finished = (subtype: string, isError: boolean) => ({ type: 'finished' as const, subtype, isError, numTurns: 2, costUsd: 0.05, usage: { input_tokens: 10 } })

describe('outcomeOf (failures 1, 2)', () => {
  it.each([
    ['success', false, false, { outcome: 'done' }],
    ['success', false, true, { outcome: 'interrupted' }],
    ['error_max_turns', true, false, { outcome: 'failed', reason: 'max_turns' }],
    ['error_max_budget_usd', true, false, { outcome: 'failed', reason: 'turn_budget' }],
    ['error_during_execution', true, false, { outcome: 'failed', reason: 'sdk_error' }],
    ['error_during_execution', true, true, { outcome: 'interrupted' }],
    // PR 5 (ask C): the SDK's structured-output give-up is the `structured_output` failure, not a generic one.
    ['error_max_structured_output_retries', true, false, { outcome: 'failed', reason: 'structured_output' }],
    ['success', true, false, { outcome: 'failed', reason: 'sdk_error' }],
  ] as const)('finished %s (isError %s, asked %s)', (subtype, isError, asked, want) => {
    expect(outcomeOf(finished(subtype, isError), asked)).toEqual(want)
  })
  it.each([
    ['interrupted', true, { outcome: 'interrupted' }],
    ['interrupted', false, { outcome: 'failed', reason: 'unknown' }],
    ['stopped', false, { outcome: 'stopped' }],
    ['timeout', false, { outcome: 'failed', reason: 'timeout' }],
    ['store', false, { outcome: 'failed', reason: 'store' }],
    ['session_crashed', false, { outcome: 'failed', reason: 'session_crashed' }],
    // PR 5 (ask C): TurnFailure has `structured_output` now (it read sdk_error until then).
    ['structured_output', false, { outcome: 'failed', reason: 'structured_output' }],
  ] as const)('failed %s (asked %s)', (reason, asked, want) => {
    expect(outcomeOf({ type: 'failed', reason, message: 'm' }, asked)).toEqual(want)
  })
})

describe('mapSdkMessage (failure 3)', () => {
  it('text and tool_use blocks, in order; labels from the map', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu', name: 'mcp__inhouse__memory_search', input: {} }, { type: 'tool_use', id: 'tu2', name: 'Mystery', input: {} }, { type: 'thinking', thinking: 'x' }] } }
    expect(mapSdkMessage(msg, false)).toEqual([
      { kind: 'text', text: 'Looking.' },
      { kind: 'step', label: 'Searching memory', tool: 'mcp__inhouse__memory_search', toolUseId: 'tu' },
      { kind: 'step', label: 'Using a tool', tool: 'Mystery', toolUseId: 'tu2' },
    ])
  })
  it("a subagent's text is not part of the answer; its tool calls are steps", () => {
    const msg = { type: 'assistant', parent_tool_use_id: 'tu_parent', message: { content: [{ type: 'text', text: 'inner' }, { type: 'tool_use', id: 'x', name: 'WebFetch', input: {} }] } }
    expect(mapSdkMessage(msg, false)).toEqual([{ kind: 'step', label: 'Reading a web page', tool: 'WebFetch', toolUseId: 'x' }])
  })
  it('a tool_use block without a string id gives a step without one (the eval trace keys inputs by it)', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }, { type: 'tool_use', id: 7, name: 'Read', input: {} }] } }
    expect(mapSdkMessage(msg, false)).toEqual([{ kind: 'step', label: 'Reading a file', tool: 'Read' }, { kind: 'step', label: 'Reading a file', tool: 'Read' }])
  })
  it('results, user messages, system messages and truncated stubs give nothing', () => {
    expect(mapSdkMessage({ type: 'result', subtype: 'success', result: 'x' }, false)).toEqual([])
    expect(mapSdkMessage({ type: 'user', message: { content: [{ type: 'text', text: 'q' }] } }, false)).toEqual([])
    expect(mapSdkMessage({ type: 'system', subtype: 'init' }, false)).toEqual([])
    expect(mapSdkMessage({ type: 'assistant', subtype: 'x', bytes: 300000 }, true)).toEqual([])
  })
})
