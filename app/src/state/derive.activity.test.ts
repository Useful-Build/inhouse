// The Activity page's rows from a real client's lines (P4 W4). Ways it could fail, written down first:
//  1. a real client has no morning-check line with `{read}` in it, yet today's first line is treated as one and hidden when
//     no tool reads (nothing shows for lines the server wrote);
//  2. a line below the stage (`minStage` Act at Watch, Run below Run) shows;
//  3. a problem line gets the read icon, or a former member's line gets an avatar name;
//  4. the demo's morning line (trace `morning`, with `{read}`) stops being the special row;
//  5. a real line whose text holds `{read}` (a member's name can: the server strips braces, but the key must not be the text)
//     is taken for the demo's morning line and hidden.
import { describe, expect, test } from 'vitest'
import { HttpAgent } from '../agent/http/client'
import type { ActivityLine, AgentData, Instant } from '../agent/types'
import { activityRows } from './derive'
import type { Ctx } from './derive'

const stub = new HttpAgent()
const EMPTY = stub.read()
const NO_STATE = stub.getSnapshot()
const at = (ms: number): Instant => ({ iso: new Date(ms).toISOString(), ms })
const NOW = Date.UTC(2026, 10, 21, 15, 0, 0)
const line = (ms: number, text: string, o: Partial<ActivityLine> = {}): ActivityLine => ({
  at: at(ms), kind: 'read', text, who: 'Your Inhouse agent', why: 'Its time came', result: 'It finished', by: { text: 'Your Inhouse agent, at {at:time}', times: { at: at(ms) } }, ...o,
})
const ctxOf = (today: ActivityLine[], earlier: ActivityLine[] = [], S: 0 | 1 | 2 = 0): Ctx =>
  ({ S, agent: NO_STATE, data: { ...EMPTY, status: 'ready', activity: { today, earlier } } as AgentData })

describe('a real client\'s lines', () => {
  test('every one of today\'s shows, with no tool connected (failure 1)', () => {
    const rows = activityRows(ctxOf([line(NOW, 'Ran a routine'), line(NOW - 60_000, 'A routine failed', { kind: 'problem' })]))
    expect(rows.map(r => r.text)).toEqual(['Ran a routine', 'A routine failed'])
  })
  test('icons follow the kind and a problem has the problem tone (failure 3)', () => {
    const rows = activityRows(ctxOf([line(NOW, 'a'), line(NOW, 'b', { kind: 'problem' }), line(NOW, 'c', { kind: 'change' })]))
    expect(rows.map(r => [r.text, r.icon])).toEqual([['a', 'visibility'], ['b', 'error'], ['c', 'check_circle']])
    expect(rows[1].iconTone).toContain('destructive')
  })
  test('a line below the stage is hidden, today and earlier (failure 2)', () => {
    const lines = [line(NOW, 'always'), line(NOW, 'needs Act', { minStage: 'Act' }), line(NOW, 'needs Run', { minStage: 'Run' })]
    for (const [S, shown] of [[0, ['always']], [1, ['always', 'needs Act']], [2, ['always', 'needs Act', 'needs Run']]] as const) {
      expect(activityRows(ctxOf(lines, [], S)).map(r => r.text), `today at stage ${S}`).toEqual(shown)
      expect(activityRows(ctxOf([], lines, S)).map(r => r.text), `earlier at stage ${S}`).toEqual(shown)
    }
  })
  test('the demo\'s morning line (trace morning, with {read}) is still the special row (failure 4)', () => {
    // No tool reads, so the demo shows no morning row; the lines after it are the demo's own "routines that ran".
    const rows = activityRows(ctxOf([line(NOW, 'Morning check: read {read} tools, found {found} things', { trace: 'morning' }), line(NOW, 'Ran a routine')]))
    expect(rows).toEqual([])
  })
  test('a line that holds {read} but isn\'t the demo\'s (a member named "{read} Kim", a run trace) shows like any other (failure 5)', () => {
    const rows = activityRows(ctxOf([line(NOW, '{read} Kim set up a routine', { kind: 'change', trace: 'r_AAAAAAAAAAAAAAAAAAAAAA' })]))
    expect(rows.map(r => r.text)).toEqual(['{read} Kim set up a routine'])
  })
  test('earlier lines get an icon by kind: needs is front_hand, problem is error (failure 3)', () => {
    const rows = activityRows(ctxOf([], [line(NOW - 86_400_000 * 2, 'n', { kind: 'needs' }), line(NOW - 86_400_000 * 2, 'p', { kind: 'problem' }), line(NOW - 86_400_000 * 2, 'r')]))
    expect(rows.map(r => [r.text, r.icon]).sort()).toEqual([['n', 'front_hand'], ['p', 'error'], ['r', 'visibility']])
  })
})
