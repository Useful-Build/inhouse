// Stage 1 M2-I: the product has no stages (plan note N17); the demo's Stage switch is unchanged. Ways it can fail, written
// first:
//  1. something in the product is locked by a stage (a tag would name it), at any pinned stage and any need;
//  2. the demo stops locking what its stage doesn't reach;
//  3. a tool's page in the product offers "Do by itself" (a later stage's ability) or tags an ability with a stage;
//  4. an Activity line is hidden in the product because of the stage it was written for, or shown in the demo below it;
//  5. Today in the product says "approved" or "caught up" over the morning check's cards, which nobody approved (their
//     drafts are placeholders, server/today/problem.ts);
//  6. a tool's page in the product claims drafting while no write operation on it is enabled (N2), or hides it once one is;
//  7. Approvals shows "Waiting for you 0" and "All caught up" under an action that waits.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from '../agent/http/client'
import type { ActivityLine, AgentData, Instant, StageIndex, ToolDetail } from '../agent/types'
import { PRODUCT_STAGE, STAGE_TAGS, activityRows, lookIds, showDraftsSection, stageLocked, todayCopy, toolAccess, toolView } from './derive'
import { cardProblem } from '../../server/today/problem'
import type { Ctx } from './derive'
import { setNow } from './display'

const stub = new HttpAgent()
const EMPTY = stub.read()
const NO_STATE = stub.getSnapshot()
const STAGES: StageIndex[] = [0, 1, 2]
const at = (iso: string): Instant => ({ iso, ms: Date.parse(iso) })
const SHOPIFY: ToolDetail = { accountId: 'shopify:store', name: 'Shopify', desc: 'd', ex: ['Q?'], read: 'r', draft: 'd', run: 'by itself', conn: 'c', site: 'shopify.com', since: at('2026-11-20T09:00:00.000Z') }
const ctxOf = (S: StageIndex, noStages: boolean, data: Partial<AgentData> = {}): Ctx =>
  ({ S, agent: NO_STATE, data: { ...EMPTY, status: 'ready', ...data } as AgentData, ...(noStages ? { noStages: true } : {}) })

describe('stageLocked', () => {
  test('the product never locks anything, at any stage and any need', () => {
    for (const S of STAGES) for (const need of [0, 1, 2, 3]) expect(stageLocked({ S, noStages: true }, need), `S=${S} need=${need}`).toBe(false)
  })
  test('the demo locks exactly what its stage does not reach', () => {
    for (const S of STAGES) for (const need of [0, 1, 2]) expect(stageLocked({ S }, need), `S=${S} need=${need}`).toBe(S < need)
  })
  test('the product is pinned to the Act view', () => {
    expect(PRODUCT_STAGE).toBe('Act')
  })
})

describe("a tool's abilities and access", () => {
  const toolsWith = (acts: boolean) => ({ ...EMPTY.tools, connected: ['shopify'], details: { shopify: { ...SHOPIFY, ...(acts ? { acts: true } : {}) } } })
  test('the product says read only while no write operation on the tool is enabled (N2)', () => {
    const ctx = ctxOf(1, true, { tools: toolsWith(false) })
    expect(toolView(ctx, 'shopify').abilities.map(a => [a.key, a.locked, a.tag])).toEqual([['read', false, 'On']])
    expect(toolAccess(ctx, 'shopify')).toBe('Read only')
  })
  test('once one is enabled, the product offers Draft for your approval too, and never a stage tag or "Do by itself"', () => {
    const ctx = ctxOf(1, true, { tools: toolsWith(true) })
    const v = toolView(ctx, 'shopify')
    expect(v.abilities.map(a => a.key)).toEqual(['read', 'draft'])
    for (const ab of v.abilities) {
      expect(ab.locked).toBe(false)
      expect(STAGE_TAGS as readonly string[]).not.toContain(ab.tag)
    }
    expect(toolAccess(ctx, 'shopify')).toBe('Read, plus drafts you approve')
  })
  test('the demo follows its stage, whatever `acts` says: at Act "Do by itself" is locked with the Run tag', () => {
    for (const acts of [false, true]) {
      const ctx = ctxOf(1, false, { tools: toolsWith(acts) })
      expect(toolView(ctx, 'shopify').abilities.map(a => [a.key, a.locked, a.tag])).toEqual([['read', false, 'On'], ['draft', false, 'On'], ['run', true, 'Run']])
      expect(toolAccess(ctx, 'shopify')).toBe('Read, plus drafts you approve')
    }
    expect(toolAccess(ctxOf(0, false, { tools: toolsWith(true) }), 'shopify')).toBe('Read only')
  })
})

describe("Today over the morning check's cards (placeholder drafts)", () => {
  const item = { ...cardProblem({ cause: 'not_run', localDate: '2026-11-26', hashed: 'h1', clock: null, atMs: Date.parse('2026-11-26T11:00:00.000Z'), areas: [], tooMany: false }, 'p_status', 'USD') }
  const found = { ...cardProblem({ cause: 'failed', localDate: '2026-11-26', hashed: 'h2', clock: '6:00 AM', atMs: Date.parse('2026-11-26T11:00:00.000Z'), areas: [], tooMany: false }, 'p_found', 'USD'), title: 'Two late orders' }
  const approvedClaim = /approved|caught up/i
  setNow(() => Date.parse('2026-11-26T15:00:00.000Z'))
  test('one card: the product says it needs you, with "1 to look at", never approved', () => {
    const ctx = ctxOf(1, true, { problems: [item] })
    expect(lookIds(ctx)).toEqual(['p_status'])
    const c = todayCopy(ctx)
    expect(c.headline).toBe('1 thing needs you today.')
    expect(c.countLabel).toBe('1 to look at')
    expect(`${c.headline} ${c.countLabel}`).not.toMatch(approvedClaim)
  })
  test('two cards, then one set aside: the count follows what is still shown', () => {
    const ctx = ctxOf(1, true, { problems: [item, found] })
    expect(todayCopy(ctx)).toMatchObject({ headline: '2 things need you today.', countLabel: '2 to look at' })
    const aside = ctxOf(1, true, { problems: [item, found] })
    const withAside = { ...aside, agent: { ...aside.agent, setAside: { p_found: { reason: 'dismissed', at: { iso: '2026-11-26T12:00:00.000Z', ms: Date.parse('2026-11-26T12:00:00.000Z') }, by: 'm_a' } } } } as unknown as Ctx
    expect(lookIds(withAside)).toEqual(['p_status'])
    expect(todayCopy(withAside)).toMatchObject({ headline: '1 thing needs you today.', countLabel: '1 to look at' })
  })
  test('the demo has none to look at: its Act copy is unchanged', () => {
    expect(lookIds(ctxOf(1, false, { problems: [item] }))).toEqual([])
  })
})

describe('Approvals: the drafts section beside the agent\'s actions', () => {
  test('hidden while only actions or questions wait; shown with none, or with a draft, or in the demo', () => {
    const ctx = ctxOf(1, true, { problems: [] })
    expect(showDraftsSection(ctx, 1)).toBe(false)
    expect(showDraftsSection(ctx, 0)).toBe(true)
    expect(showDraftsSection(ctxOf(1, false, { problems: [] }), 0)).toBe(true)
    expect(showDraftsSection(ctxOf(0, false, { problems: [] }), 0)).toBe(false)
  })
})

describe('Activity', () => {
  const line = (text: string, minStage?: ActivityLine['minStage']): ActivityLine =>
    ({ at: at('2026-11-18T10:00:00.000Z'), kind: 'read', text, who: 'Inhouse agent', why: 'w', result: 'r', by: { text: 'b', times: {} }, ...(minStage ? { minStage } : {}) })
  const activity = { today: [], earlier: [line('plain'), line('from Act', 'Act'), line('from Run', 'Run')] }
  const texts = (ctx: Ctx) => activityRows(ctx).map(r => r.text)
  test('the product shows every line, whatever stage it was written for', () => {
    expect(texts(ctxOf(1, true, { activity }))).toEqual(['plain', 'from Act', 'from Run'])
  })
  test('the demo still hides a line below its stage', () => {
    expect(texts(ctxOf(1, false, { activity }))).toEqual(['plain', 'from Act'])
    expect(texts(ctxOf(0, false, { activity }))).toEqual(['plain'])
  })
})
