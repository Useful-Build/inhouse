// The write tools' server in a turn's start (Stage 1 M2-D; N1, N2, N14). Ways it can fail: a start carries `actions`
// while no operation is on for the brand (the runner would then list write tools in a deployable build), carries
// `actions: false` (a runner on an image before v4, a strict schema without the key, would refuse every run), or the
// start with it no longer parses as the protocol's.
import { env } from 'cloudflare:workers'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunStart } from '../../../shared/protocol/index.ts'
import { ceiling, resetPermissions } from '../../permissions/test-support.ts'
import { inAgent, settle } from '../../testing/brand-agent/core-harness.ts'
import type { RunStart as Start } from '../../../shared/protocol/index.ts'
import { SYSTEM_PROMPT_V2 } from '../../prompt/system.ts'
import { actionsOn } from './asks.ts'
import { buildStart, type StartInput } from './run-start.ts'

const input = (over: Partial<StartInput>): StartInput => ({
  turnId: 't_turn1', chatId: 'chat-a', sessionId: '00000000-0000-4000-8000-00000000000a', expect: null, text: 'hi', quote: null,
  attachments: [], model: 'claude-sonnet-5-5', sideModel: 'claude-haiku-5-5', effort: 'medium', maxTurns: 25,
  webFetchDomains: [], systemPrompt: 'p', ...over,
})

describe('buildStart: actions', () => {
  it('only `actions: true` when on; off or absent sends no key', () => {
    for (const off of [{}, { actions: false }]) expect('actions' in buildStart(input(off))).toBe(false)
    expect(RunStart.parse({ ...buildStart(input({ actions: true })), runToken: 'x'.repeat(32) }).actions).toBe(true)
  })
})

describe('actionsOn: an operation enabled for the brand (N2)', () => {
  beforeEach(async () => { await resetPermissions(env.DB) })
  it('false with no ceiling row or only turned-off ones; true once one is on', async () => {
    expect(await actionsOn(env.DB)).toBe(false)
    await ceiling(env.DB, 'shopify.order.tag_add', { enabled: false, perDayMax: 50, loweredRev: 1 })
    expect(await actionsOn(env.DB)).toBe(false)
    await ceiling(env.DB, 'slack.channel.post', { enabled: true, perDayMax: 50, loweredRev: 1 })
    expect(await actionsOn(env.DB)).toBe(true)
  })
})

describe('the engine: each start asks whether an operation is on', () => {
  const started = (on: () => Promise<boolean>) => {
    let start: Start | null = null
    return inAgent(async h => {
      const a = await h.submit('c_act', 'key-actions1')
      if ('refused' in a) throw new Error('refused')
      await settle()
      start = h.pool.calls.find(c => c.method === 'place')!.args[0] as Start
    }, { actionsOn: on }).then(() => start!)
  }
  it('on: the start carries actions; off, or a read that throws: no key (the turn still starts)', async () => {
    expect((await started(async () => true)).actions).toBe(true)
    expect('actions' in (await started(async () => false))).toBe(false)
    expect('actions' in (await started(async () => { throw new Error('d1 down') }))).toBe(false)
  })
})

// Stage 1 M2-G (N20): the prompt says the agent can act exactly when the start carries `actions`. Ways it can fail: the
// start reads the ceiling again apart from the prompt (an operation turned off between the two reads gives words without
// tools, or tools the words don't mention), or a builder that failed (the static v2, which names no operation) still
// starts with `actions`.
describe("the engine: a built prompt's word on acting decides the start's `actions`", () => {
  const started = (built: () => Promise<{ text: string; version: number; actions?: boolean }>, on: () => Promise<boolean>) => {
    let start: Start | null = null
    return inAgent(async h => {
      const a = await h.submit('c_act', 'key-actions2')
      if ('refused' in a) throw new Error('refused')
      await settle()
      start = h.pool.calls.find(c => c.method === 'place')!.args[0] as Start
    }, { systemPrompt: built, actionsOn: on }).then(() => start!)
  }
  it('the prompt says it can act: `actions`, whatever a second read would say; it says it can\'t: no key', async () => {
    expect((await started(async () => ({ text: 'p', version: 5, actions: true }), async () => false)).actions).toBe(true)
    expect('actions' in (await started(async () => ({ text: 'p', version: 5, actions: false }), async () => true))).toBe(false)
  })
  it('a builder that failed sends the static v2 and no `actions`, even with an operation on', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const s = await started(async () => { throw new Error('boom') }, async () => true)
      expect('actions' in s).toBe(false)
      expect(s.systemPrompt).toBe(SYSTEM_PROMPT_V2)
    } finally {
      errors.mockRestore()
    }
  })
  it('a builder that gives no word (an older one) still asks `actionsOn`', async () => {
    expect((await started(async () => ({ text: 'p', version: 4 }), async () => true)).actions).toBe(true)
  })
})
