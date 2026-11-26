// Stage 1 M2-I: the product has no stages (plan note N17); the demo's Stage switch is unchanged. Ways it can fail, written
// first:
//  1. something in the product is locked by a stage (a tag would name it), at any pinned stage and any need;
//  2. the demo stops locking what its stage doesn't reach;
//  3. a tool's page in the product offers "Do by itself" (a later stage's ability) or tags an ability with a stage;
//  4. an Activity line is hidden in the product because of the stage it was written for, or shown in the demo below it.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from '../agent/http/client'
import type { ActivityLine, AgentData, Instant, StageIndex, ToolDetail } from '../agent/types'
import { PRODUCT_STAGE, STAGE_TAGS, activityRows, stageLocked, toolView } from './derive'
import type { Ctx } from './derive'

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

describe("a tool's abilities", () => {
  const tools = { ...EMPTY.tools, connected: ['shopify'], details: { shopify: SHOPIFY } }
  test('the product offers Read and Draft only, tagged with the tool state, never a stage', () => {
    const v = toolView(ctxOf(1, true, { tools }), 'shopify')
    expect(v.abilities.map(a => a.key)).toEqual(['read', 'draft'])
    for (const ab of v.abilities) {
      expect(ab.locked).toBe(false)
      expect(STAGE_TAGS as readonly string[]).not.toContain(ab.tag)
    }
  })
  test('the demo at Act keeps "Do by itself", locked with the Run tag', () => {
    const v = toolView(ctxOf(1, false, { tools }), 'shopify')
    expect(v.abilities.map(a => [a.key, a.locked, a.tag])).toEqual([['read', false, 'On'], ['draft', false, 'On'], ['run', true, 'Run']])
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
