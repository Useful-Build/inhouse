// Stage 1 M3-W (N32's first line): the scripted model's write loop for the sandbox spec (e2e/api/write-loop.spec.ts,
// `needsContainer()`), with tag_add turned on only through the test-fakes hook (N2, N19). `write-loop`: the agent calls
// the `actions` server's `shopify_order_tag_add` 500 times, one order each, `WRITE_LOOP_PER_TURN` calls at a time in
// `WRITE_LOOP_TURNS` turns, then closes. Each call carries its own tag (`<loop tag>-<k>`, k from 1), the loop tag taken
// from the person's message (`loop-tag:<tag>`), so each run of the spec counts only its own writes. Every turn after
// the first is answered only when every call of the turn before came back without an error: the egress answered each
// (run under the permission, or collected onto the one card), whatever the rules made of it.
import type { MessagesRequest, Scenario, ScriptedBlock, ScriptedTurn } from '../index.ts'

type Check = NonNullable<ScriptedTurn['expect']>

export const WRITE_LOOP_TOOL = 'mcp__actions__shopify_order_tag_add'
export const WRITE_LOOP_CALLS = 500
export const WRITE_LOOP_PER_TURN = 25
export const WRITE_LOOP_TURNS = WRITE_LOOP_CALLS / WRITE_LOOP_PER_TURN
export const WRITE_LOOP_DONE = 'The 500 tag calls are made.'
/** The loop's tag when the person's message names none. */
export const WRITE_LOOP_DEFAULT_TAG = 'm3w-loop'
const LOOP_TAG = /loop-tag:([a-z0-9-]{1,30})/

/** Call `k`'s arguments (1-based): one of the fake store's three orders and a tag of its own. */
export const loopArgs = (tag: string, k: number) => ({ orderIds: [`gid://shopify/Order/${9001 + (k % 3)}`], tags: [`${tag}-${k}`] })
const callId = (k: number) => `toolu_scripted_loop_${k}`

/** A user message's prompt text: its string, or its text blocks joined; empty for a tool result. */
function promptText(m: MessagesRequest['messages'][number]): string {
  if (m.role !== 'user') return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  const blocks = m.content as { type?: unknown; text?: unknown }[]
  if (blocks.some(b => b?.type === 'tool_result')) return ''
  return blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text as string).join('\n')
}

const tagOf = (r: MessagesRequest): string => LOOP_TAG.exec(r.messages.map(promptText).join('\n'))?.[1] ?? WRITE_LOOP_DEFAULT_TAG

/** Turn `t`'s calls (0-based turn): calls `t * PER_TURN + 1` to `(t + 1) * PER_TURN`. */
const callsOf = (tag: string, t: number): ScriptedBlock[] =>
  Array.from({ length: WRITE_LOOP_PER_TURN }, (_, i) => {
    const k = t * WRITE_LOOP_PER_TURN + i + 1
    return { type: 'tool_use', id: callId(k), name: WRITE_LOOP_TOOL, input: loopArgs(tag, k) }
  })

/** Every call of turn `t` has a result, and none is an error. */
const turnAnswered = (t: number): Check => r => {
  const results = new Map<string, { is_error?: unknown }>()
  for (const m of r.messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content as { type?: unknown; tool_use_id?: unknown; is_error?: unknown }[]) {
      if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') results.set(b.tool_use_id, b)
    }
  }
  for (let i = 0; i < WRITE_LOOP_PER_TURN; i++) {
    const id = callId(t * WRITE_LOOP_PER_TURN + i + 1)
    const b = results.get(id)
    if (!b) return `no result for ${id}`
    if (b.is_error === true) return `the result for ${id} is an error`
  }
  return true
}

export function limitsScenarios(mainLoop: (tool?: string) => Check): Record<string, Scenario> {
  const loop = mainLoop()
  const both = (...checks: Check[]): Check => r => {
    for (const c of checks) {
      const v = c(r)
      if (v !== true) return v
    }
    return true
  }
  const turns: ScriptedTurn[] = Array.from({ length: WRITE_LOOP_TURNS }, (_, t) => ({
    content: callsOf(WRITE_LOOP_DEFAULT_TAG, t),
    contentFor: r => callsOf(tagOf(r), t),
    expect: t === 0 ? loop : both(loop, turnAnswered(t - 1)),
  }))
  turns.push({ content: [{ type: 'text', text: WRITE_LOOP_DONE }], expect: both(loop, turnAnswered(WRITE_LOOP_TURNS - 1)) })
  return { 'write-loop': { turns } }
}
