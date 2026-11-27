// How the server's handlers are composed from areas. Ways it can fail, written down first: a tool with two handlers
// accepted (one silently wins); a registry tool with none accepted (it would fail only when called); a stub not
// replaced by the area built after it; a handler for a name outside the registry accepted. Names are literals here.
import { describe, expect, it } from 'vitest'
import { refusal } from '../server/tool.ts'
import type { ToolHandler } from '../server/tool.ts'
import { TOOL_HANDLERS, composeHandlers } from './index.ts'
import { z } from 'zod'
import { dataOf } from '../server/test-support.ts'

const h = (label: string): ToolHandler => ({ input: z.object({}), call: async () => refusal(label, label) })
const REGISTRY = ['memory_search', 'routine_list', 'routine_create']
const STUBS = ['routine_list', 'routine_create']
const stubs = ['stubs', { routine_list: h('stub'), routine_create: h('stub') }] as const

describe('composeHandlers', () => {
  it('a later area replaces a stub, and only a stub', async () => {
    const map = composeHandlers([stubs, ['memory', { memory_search: h('m') }], ['routines', { routine_list: h('real') }]], REGISTRY, STUBS)
    expect(dataOf((await map.get('routine_list')!.call({}, null as never, null as never)))).toEqual({ error: 'real' })
    expect(dataOf((await map.get('routine_create')!.call({}, null as never, null as never)))).toEqual({ error: 'stub' })
  })
  it('a tool with two handlers fails, whichever order', () => {
    expect(() => composeHandlers([stubs, ['memory', { memory_search: h('a') }], ['other', { memory_search: h('b') }]], REGISTRY, STUBS)).toThrow('memory_search has two handlers (memory, other)')
    expect(() => composeHandlers([stubs, ['a', { routine_list: h('a') }], ['b', { routine_list: h('b') }], ['memory', { memory_search: h('m') }]], REGISTRY, STUBS)).toThrow('routine_list has two handlers (a, b)')
  })
  it('a registry tool with no handler fails; so does a handler outside the registry', () => {
    expect(() => composeHandlers([stubs], REGISTRY, STUBS)).toThrow('no handler for memory_search')
    expect(() => composeHandlers([stubs, ['memory', { memory_search: h('m'), memory_drop: h('x') } as never]], REGISTRY, STUBS)).toThrow("memory handles memory_drop, which isn't in the registry")
  })
})

describe('the composed map', () => {
  it('has one handler per registry tool; the seven built ones are not stubs', async () => {
    expect([...TOOL_HANDLERS.keys()].sort()).toEqual([
      'approval_get', 'approval_list', 'approval_request', 'approval_withdraw', 'history_read', 'history_search', 'memory_forget', 'memory_list',
      'memory_save', 'memory_search', 'memory_update', 'notification_send', 'question_ask', 'routine_create', 'routine_delete', 'routine_list',
      'routine_run_now', 'routine_update', 'skill_save', 'team_request_create', 'team_request_list',
    ])
    for (const name of ['memory_search', 'memory_save', 'memory_update', 'memory_forget', 'memory_list', 'history_search', 'history_read']) {
      expect(TOOL_HANDLERS.get(name)!.input.safeParse({ anything: 1 }).success, name).toBe(false)
    }
  })
})
