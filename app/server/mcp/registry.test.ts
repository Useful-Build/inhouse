// The `inhouse` tool list. Ways it can fail, written first: a tool missing, renamed or added beyond the approved 20; the
// always-loaded six wrong; a name off the `resource_action` rule; a read without readOnlyHint or a forget, delete or
// withdraw without destructiveHint. The 20 names and the six are literals here (from the approved tool list,
// agent-tools 2026-11-14), never read from the registry.
import { describe, expect, it } from 'vitest'
import { ALWAYS_LOAD_META_KEY, INHOUSE_TOOLS } from './registry.ts'

const THE_20 = [
  'memory_search', 'memory_save', 'memory_update', 'memory_forget', 'memory_list',
  'approval_request', 'approval_get', 'approval_list', 'approval_withdraw',
  'question_ask',
  'routine_create', 'routine_list', 'routine_update', 'routine_delete', 'routine_run_now',
  'history_search', 'history_read',
  'notification_send',
  'team_request_create', 'team_request_list',
]
const THE_6 = ['memory_search', 'memory_save', 'approval_request', 'question_ask', 'history_search', 'notification_send']

describe('the inhouse tool registry', () => {
  it('is exactly the 20, in the list\'s order, with the six always loaded', () => {
    expect(INHOUSE_TOOLS.map(t => t.name)).toEqual(THE_20)
    expect(INHOUSE_TOOLS.filter(t => t.alwaysLoad).map(t => t.name)).toEqual(THE_6)
    expect(ALWAYS_LOAD_META_KEY).toBe('anthropic/alwaysLoad')
  })
  it('names each tool resource_action and describes it', () => {
    for (const t of INHOUSE_TOOLS) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)+$/)
      expect(t.description.length, t.name).toBeGreaterThan(30)
    }
  })
  it('marks the reads and the destructive ones', () => {
    const reads = ['memory_search', 'memory_list', 'approval_get', 'approval_list', 'routine_list', 'history_search', 'history_read', 'team_request_list']
    const destructive = ['memory_forget', 'approval_withdraw', 'routine_delete']
    expect(INHOUSE_TOOLS.filter(t => t.annotations.readOnlyHint).map(t => t.name)).toEqual(reads)
    expect(INHOUSE_TOOLS.filter(t => t.annotations.destructiveHint).map(t => t.name)).toEqual(destructive)
  })
})
