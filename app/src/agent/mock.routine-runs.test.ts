// The demo answers route 86's shape from its sample data (master plan decision 8). Ways it can fail, written down first:
//  1. an answer the server's schema would refuse (an extra field, an outcome off the list, oldest first, over the cap),
//     so the panel works in the demo and breaks in the product;
//  2. a Run now isn't the newest line, or one with no result claims it finished;
//  3. day one, or a stage a routine doesn't run at, shows the sample's earlier runs;
//  4. an unknown or deleted routine answers runs instead of rejecting.
import { describe, expect, test, vi } from 'vitest'
import { RoutineRunHistorySchema } from '../../shared/contract/routines'
import { SCENARIOS, STAGES } from './types'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } })
const { MockAgent } = await import('./mock')
const { routineIdOf } = await import('./data')

const MORNING = routineIdOf('Morning check')
const PAYOUT = routineIdOf('Amazon payout check')
const fresh = () => { store.clear(); return new MockAgent() }

describe('the demo: a routine\'s runs', () => {
  test('every stage, scenario and routine answers the server\'s shape, newest first', async () => {
    const agent = fresh()
    for (const stage of STAGES) {
      for (const scenario of SCENARIOS) {
        agent.setDemo({ stage, scenario })
        for (const r of agent.read().routines) {
          const { runs } = RoutineRunHistorySchema.parse(await agent.routineRunHistory(r.id))
          expect(runs.map(x => x.at.ms), `${stage} ${scenario} ${r.name}`).toEqual(runs.map(x => x.at.ms).sort((a, b) => b - a))
        }
      }
    }
  })

  test('the sample runs at a stage the routine runs at; none at a stage below it, none on day one', async () => {
    const agent = fresh()
    agent.setDemo({ stage: 'Act', scenario: 'Normal' })
    const morning = (await agent.routineRunHistory(MORNING)).runs
    expect(morning.map(x => [x.outcome, x.result, x.manual, x.trace])).toEqual([
      ['done', 'found 6 things', false, 'morning'],
      ['done', 'found 3 things', false, 'morning'],
      ['done', 'found 4 things', false, 'morning'],
    ])
    expect((await agent.routineRunHistory(PAYOUT)).runs.map(x => x.result)).toEqual(['Found a $1,240 gap', 'Every payout matched what Xero expected'])
    agent.setDemo({ stage: 'Watch', scenario: 'Normal' })
    expect((await agent.routineRunHistory(PAYOUT)).runs).toEqual([])
    expect((await agent.routineRunHistory(MORNING)).runs).toHaveLength(3)
    agent.setDemo({ stage: 'Act', scenario: 'First day' })
    expect((await agent.routineRunHistory(MORNING)).runs).toEqual([])
  })

  test('a Run now heads the list, finished, with the routine\'s result or "It finished" when there is none', async () => {
    const agent = fresh()
    agent.setDemo({ stage: 'Act', scenario: 'Normal' })
    const run = await agent.runRoutine(PAYOUT)
    const [first, ...rest] = (await agent.routineRunHistory(PAYOUT)).runs
    expect(first).toEqual({ at: run.at, outcome: 'done', result: 'found a $1,240 gap', manual: true })
    expect(rest).toHaveLength(2)
    agent.setDemo({ stage: 'Act', scenario: 'First day' })
    await agent.runRoutine(MORNING)
    expect((await agent.routineRunHistory(MORNING)).runs).toEqual([expect.objectContaining({ outcome: 'done', result: 'It finished', manual: true, trace: 'morning' })])
  })

  test('an unknown or deleted routine rejects as not found', async () => {
    const agent = fresh()
    agent.setDemo({ stage: 'Act', scenario: 'Normal' })
    await expect(agent.routineRunHistory('routine-nope')).rejects.toMatchObject({ code: 'not_found' })
    await agent.deleteRoutine(PAYOUT)
    await expect(agent.routineRunHistory(PAYOUT)).rejects.toMatchObject({ code: 'not_found' })
  })
})
