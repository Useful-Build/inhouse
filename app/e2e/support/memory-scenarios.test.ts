// The scripted memory scenarios the P6a ship spec relies on (e2e/ship/memory-skills.spec.ts). They can only run in a container on
// the deployed test build, so the way each one reads the message's reference and the search result's memory id is proved here,
// against the scripted model itself. Ways they could fail, written first:
//  - a turn says another run's fact (the reference isn't read from the message);
//  - the reword calls memory_update with no id, or with the wrong one;
//  - "found" is answered for a result that doesn't hold the fact, or "nothing" for one that does;
//  - the refusal for "Learn from my chats" being off is told as a save, or the reverse.
import { describe, expect, test } from 'vitest'
import { createScriptedModel } from '../../test/scripted-model/index.ts'
import {
  HARNESS_MODEL, LEARNING_OFF_ANSWER, MEMORY_REWORD_CHANGED_ANSWER, MEMORY_REWORD_LEARNING_OFF_ANSWER, LEARNING_SAVED_ANSWER, MEMORY_RECALL_NONE, MEMORY_SAVE_TEXT, SCENARIOS, TEAM_FACT_CHANGED_ANSWER,
  TEAM_FACT_SAVED_ANSWER, memoryRecallAnswer, teamFactReworded, teamFactText,
} from '../../test/scripted-model/scenarios.ts'

const REF = 'fx0a1b2c3d'
type Block = { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }

/** A main-loop request after `calls` tool calls, each answered by `results` (its text and whether it refused). */
function request(scenario: string, calls: { id: string; name: string; input: Record<string, unknown> }[], results: { text: string; error?: boolean }[], ref: string | null = REF) {
  const first = `scenario:${scenario} please do it${ref ? ` [${ref}]` : ''}`
  const messages: unknown[] = [{ role: 'user', content: first }]
  calls.forEach((c, i) => {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: c.id, name: c.name, input: c.input }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content: results[i]!.text, ...(results[i]!.error ? { is_error: true } : {}) }] })
  })
  return new Request('http://scripted.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: HARNESS_MODEL, tools: [{ name: 'Bash' }, { name: 'mcp__inhouse__memory_save' }, { name: 'mcp__inhouse__memory_search' }, { name: 'mcp__inhouse__memory_update' }], messages }),
  })
}
const answer = async (res: Response): Promise<{ status: number; content: Block[] }> => ({ status: res.status, content: res.status === 200 ? ((await res.json()) as { content: Block[] }).content : [] })
const SEARCH = 'toolu_scripted_team_ref_recall'
const hit = (text: string) => `1 saved fact matches:\n- [brand] ${text} (memory_id: mem_AbC123_x-9)`

describe('the P6a memory scenarios', () => {
  test('memory-save-team-ref saves the fact with the message\'s reference, for the team, then answers', async () => {
    const model = createScriptedModel(SCENARIOS)
    const first = await answer(await model.handle(request('memory-save-team-ref', [], []), 'memory-save-team-ref'))
    expect(first.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'mcp__inhouse__memory_save', input: { scope: 'brand', text: teamFactText(REF) } })])
    const call = { id: first.content[0]!.id!, name: 'mcp__inhouse__memory_save', input: first.content[0]!.input! }
    const second = await answer(await model.handle(request('memory-save-team-ref', [call], [{ text: 'Saved for the team' }]), 'memory-save-team-ref'))
    expect(second.content).toEqual([{ type: 'text', text: TEAM_FACT_SAVED_ANSWER }])
    // Another message names another reference: another fact. One that names none is a loud miss, not a fact without one.
    const other = await answer(await model.handle(request('memory-save-team-ref', [], [], 'fxffffffff'), 'memory-save-team-ref'))
    expect(other.content[0]!.input).toEqual({ scope: 'brand', text: teamFactText('fxffffffff') })
    expect((await answer(await model.handle(request('memory-save-team-ref', [], [], null), 'memory-save-team-ref'))).status).toBe(400)
  })

  test.each([
    ['memory-recall-team-ref', teamFactText],
    ['memory-recall-team-ref-reworded', teamFactReworded],
  ])('%s says the fact only when the search result holds it in these words', async (name, wording) => {
    const model = createScriptedModel(SCENARIOS)
    const id = name.endsWith('reworded') ? 'toolu_scripted_team_ref_recall_reworded' : SEARCH
    const first = await answer(await model.handle(request(name, [], []), name))
    expect(first.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'mcp__inhouse__memory_search', input: { query: REF } })])
    const call = { id, name: 'mcp__inhouse__memory_search', input: { query: REF } }
    expect((await answer(await model.handle(request(name, [call], [{ text: hit(wording(REF)) }]), name))).content).toEqual([{ type: 'text', text: memoryRecallAnswer(wording(REF)) }])
    expect((await answer(await model.handle(request(name, [call], [{ text: `Nothing saved matches "${REF}".` }]), name))).content).toEqual([{ type: 'text', text: MEMORY_RECALL_NONE }])
    // The other wording of the same fact is not this scenario's fact.
    const otherWording = wording === teamFactText ? teamFactReworded : teamFactText
    expect((await answer(await model.handle(request(name, [call], [{ text: hit(otherWording(REF)) }]), name))).content).toEqual([{ type: 'text', text: MEMORY_RECALL_NONE }])
    // A tool error (e.g. inhouse MCP didn't connect so memory_search isn't available) must miss loudly instead of
    // silently answering "Nothing saved matches that."
    const errored = await model.handle(request(name, [call], [{ text: 'Error: No such tool available: mcp__inhouse__memory_search', error: true }]), name)
    expect(errored.status).toBe(400)
    expect(model.misses.at(-1)?.reason).toContain('has is_error true, not false; it says: "Error: No such tool available: mcp__inhouse__memory_search"')
  })

  test('memory-recall-team-ref misses on turn 0 when mcp__inhouse__memory_search is absent even with DeferredToolPlaceholder', async () => {
    const model = createScriptedModel(SCENARIOS)
    const noInhouseMcp = new Request('http://scripted.invalid/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: HARNESS_MODEL,
        tools: [{ name: 'Bash' }, { name: 'DeferredToolPlaceholder', defer_loading: true }],
        messages: [{ role: 'user', content: `scenario:memory-recall-team-ref recall [${REF}]` }],
      }),
    })
    expect((await model.handle(noInhouseMcp, 'memory-recall-team-ref')).status).toBe(400)
    expect(model.misses.at(-1)?.reason).toContain("the tool list doesn't offer mcp__inhouse__memory_search")
  })

  test('memory-reword-team-ref finds the fact, rewords it by the memory id the search gave, and answers', async () => {
    const model = createScriptedModel(SCENARIOS)
    const name = 'memory-reword-team-ref'
    const search = { id: 'toolu_scripted_reword_search', name: 'mcp__inhouse__memory_search', input: { query: REF } }
    const first = await answer(await model.handle(request(name, [], []), name))
    expect(first.content).toEqual([expect.objectContaining({ type: 'tool_use', name: search.name, input: search.input })])
    const second = await answer(await model.handle(request(name, [search], [{ text: hit(teamFactText(REF)) }]), name))
    expect(second.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'mcp__inhouse__memory_update', input: { memory_id: 'mem_AbC123_x-9', text: teamFactReworded(REF) } })])
    const update = { id: second.content[0]!.id!, name: 'mcp__inhouse__memory_update', input: second.content[0]!.input! }
    expect((await answer(await model.handle(request(name, [search, update], [{ text: hit(teamFactText(REF)) }, { text: 'Changed' }]), name))).content).toEqual([{ type: 'text', text: TEAM_FACT_CHANGED_ANSWER }])
    // The search found nothing (the fact isn't active): a loud miss, never an update of no fact.
    expect((await answer(await model.handle(request(name, [search], [{ text: `Nothing saved matches "${REF}".` }]), name))).status).toBe(400)
  })

  test('memory-save-learning tells a refusal apart from a save', async () => {
    const model = createScriptedModel(SCENARIOS)
    const name = 'memory-save-learning'
    const first = await answer(await model.handle(request(name, [], [], null), name))
    expect(first.content).toEqual([expect.objectContaining({ type: 'tool_use', name: 'mcp__inhouse__memory_save', input: { scope: 'person', text: MEMORY_SAVE_TEXT } })])
    const call = { id: first.content[0]!.id!, name: 'mcp__inhouse__memory_save', input: first.content[0]!.input! }
    const refused = { text: 'Not saved: this person turned off "Learn from my chats" in Settings, so don\'t save their preferences.', error: true }
    expect((await answer(await model.handle(request(name, [call], [refused], null), name))).content).toEqual([{ type: 'text', text: LEARNING_OFF_ANSWER }])
    expect((await answer(await model.handle(request(name, [call], [{ text: 'Saved (memory_id: mem_x). It counts from now, for this person only.' }], null), name))).content).toEqual([{ type: 'text', text: LEARNING_SAVED_ANSWER }])
  })

  test('memory-save-reword-person: only the learning_off refusal says "off", a plain success says "changed", any other error is a loud miss', async () => {
    const model = createScriptedModel(SCENARIOS)
    const name = 'memory-save-reword-person'
    const first = await answer(await model.handle(request(name, [], [], null), name))
    const call = { id: first.content[0]!.id!, name: 'mcp__inhouse__memory_update', input: first.content[0]!.input! }
    const off = { text: 'Not changed: this person turned off "Learn from my chats" in Settings.', error: true }
    expect((await answer(await model.handle(request(name, [call], [off], null), name))).content).toEqual([{ type: 'text', text: MEMORY_REWORD_LEARNING_OFF_ANSWER }])
    expect((await answer(await model.handle(request(name, [call], [{ text: 'Changed.' }], null), name))).content).toEqual([{ type: 'text', text: MEMORY_REWORD_CHANGED_ANSWER }])
    // The refusal text without the error flag is not a refusal; an unrelated error is neither branch.
    expect((await model.handle(request(name, [call], [{ text: off.text }], null), name)).status).toBe(400)
    const broken = 'Error: No such tool available: mcp__inhouse__memory_update'
    expect((await model.handle(request(name, [call], [{ text: broken, error: true }], null), name)).status).toBe(400)
    expect(model.misses.at(-1)?.reason).toContain(broken)
  })

  test('memory-save-reword-team misses loudly, quoting the error, when memory_update errors', async () => {
    const model = createScriptedModel(SCENARIOS)
    const name = 'memory-save-reword-team'
    const first = await answer(await model.handle(request(name, [], [], null), name))
    const call = { id: first.content[0]!.id!, name: 'mcp__inhouse__memory_update', input: first.content[0]!.input! }
    expect((await answer(await model.handle(request(name, [call], [{ text: 'Reworded (memory_id: mem_x).' }], null), name))).content).toEqual([{ type: 'text', text: 'Reworded.' }])
    const broken = 'Error: No such tool available: mcp__inhouse__memory_update'
    expect((await model.handle(request(name, [call], [{ text: broken, error: true }], null), name)).status).toBe(400)
    expect(model.misses.at(-1)?.reason).toContain(broken)
  })
})
