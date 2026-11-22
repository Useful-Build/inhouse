// The BrandAgent carries the turn's system prompt v2 (P5): the prompt is built when each turn starts, so a turn started
// after Slack is paused no longer names it. Ways it can fail, written down first: the prompt is read once at the
// object's start and every later turn carries a stale line; a turn's start carries v1 without the turn lines; a failed
// hub read stops the turn. Expected prompts are literals here.
import { describe, expect, it, vi } from 'vitest'
import type { AccountSummary, HubResult } from '../../hub/index/contract.ts'
import { inAgent, settle } from '../testing/brand-agent/core-harness.ts'
import type { SendTurnResult } from '../../shared/contract/runs.ts'
import type { Refusal } from '../do/brand-agent/ports.ts'
import { turnSystemPrompt } from './connected.ts'
import { SYSTEM_PROMPT_V1 } from './system.ts'

const ok = (r: SendTurnResult | Refusal): SendTurnResult => {
  if ('refused' in r) throw new Error(`refused ${JSON.stringify(r.refused)}`)
  return r
}
const slack = (paused: boolean): AccountSummary => ({
  accountId: 'slack:workspace', connector: 'slack', configured: true,
  status: {
    accountId: 'slack:workspace', state: 'active', kid: 'k1', expiresAt: null, scopes: [], lastError: null, paused, kind: 'oauth_mcp',
    connectedBy: null, connectedAt: null, revokeFailedAt: null, needsReconnect: false,
  },
})

describe("the turn's system prompt", () => {
  it('carries the connected-apps line read when the turn starts', async () => {
    let answer: HubResult<AccountSummary[]> = { ok: true, value: [slack(false)] }
    const deps = { gateway: { listAccounts: async () => answer }, delivery: true, channels: async () => ['ops'] }
    await inAgent(async h => {
      const a = ok(await h.submit('c1', 'key-prompt1'))
      await settle()
      const first = JSON.parse(h.turn(a.turnId).start_json!) as { systemPrompt: string }
      expect(first.systemPrompt).toBe(`${SYSTEM_PROMPT_V1}\n\nConnected apps: Slack. Search for their tools with tool search when a question needs their data.\n`
        + 'Slack channels you may post to with notification_send: #ops. Post nowhere else.')

      answer = { ok: true, value: [slack(true)] }
      const b = ok(await h.submit('c2', 'key-prompt2'))
      await settle()
      expect((JSON.parse(h.turn(b.turnId).start_json!) as { systemPrompt: string }).systemPrompt).toBe(`${SYSTEM_PROMPT_V1}\n\nNo apps are connected yet.`)

      vi.spyOn(console, 'error').mockImplementation(() => {})
      answer = { ok: false, error: { code: 'upstream_unavailable', message: 'down' } }
      const c = ok(await h.submit('c3', 'key-prompt3'))
      await settle()
      expect((JSON.parse(h.turn(c.turnId).start_json!) as { systemPrompt: string }).systemPrompt).toBe(SYSTEM_PROMPT_V1)
      expect(h.placed()).toEqual([a.turnId, b.turnId, c.turnId])
      vi.restoreAllMocks()
    }, { systemPrompt: turnId => turnSystemPrompt(deps, turnId) })
  })
})
