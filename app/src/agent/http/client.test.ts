// The product's client stub (client.ts) until P2 connects it. Ways it could break what the product shell relies on,
// written down before the tests:
//  - a read returns a new object each call (React re-renders forever) or a value its schema rejects;
//  - a read carries a demo field (the scenario data, the demo's start) the product contract doesn't have;
//  - a write resolves, rejects with something other than AgentError('unavailable'), or tells nobody;
//  - a notice listener still hears after it unsubscribed;
//  - `ask` starts a run, or its failure arrives as a write's notice.
import { describe, expect, test } from 'vitest'
import { AgentDataSchema, AgentStateSchema } from '../../../shared/contract'
import type { AgentClient, AgentNotice } from '../types'
import { AgentError } from '../types'
import { HttpAgent } from './client'

/** Every write, with arguments of the right shape. */
const WRITES: [string, (c: AgentClient) => Promise<unknown>][] = [
  ['approve', c => c.approve('p')], ['undo', c => c.undo('p')], ['editDraft', c => c.editDraft('p', 'x')],
  ['undoHandled', c => c.undoHandled('p')], ['redoHandled', c => c.redoHandled('p')],
  ['createChat', c => c.createChat({ id: 'c', title: 't' })], ['send', c => c.send('r', 'x')], ['interrupt', c => c.interrupt('r')],
  ['pause', c => c.pause()], ['resume', c => c.resume()], ['setToggle', c => c.setToggle('k', true)],
  ['requestTool', c => c.requestTool('k', true)], ['requestSkill', c => c.requestSkill('s')], ['setToolPaused', c => c.setToolPaused('k', true)],
  ['forgetMemory', c => c.forgetMemory('k', true)], ['setSetting', c => c.setSetting('k', 'v')], ['setPhoto', c => c.setPhoto('p', null)],
  ['sendTeamRequest', c => c.sendTeamRequest({ icon: 'build', title: 't', sub: 's', at: { iso: '2030-01-01T00:00:00.000Z', ms: Date.UTC(2030, 0, 1) }, status: 'Sent' })],
  ['markNoticesRead', c => c.markNoticesRead(['n'])], ['deleteFiles', c => c.deleteFiles(['f'])], ['restoreFiles', c => c.restoreFiles(['f'])],
  ['setAside', c => c.setAside('p', 'snoozed')], ['runRoutine', c => c.runRoutine('r')], ['deleteRoutine', c => c.deleteRoutine('r')],
  ['restoreRoutine', c => c.restoreRoutine('r')], ['renameChat', c => c.renameChat('c', 't')], ['pinChat', c => c.pinChat('c', true)],
  ['deleteChats', c => c.deleteChats(['c'])], ['restoreChats', c => c.restoreChats(['c'])],
]

const errorOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => 'resolved', (e: unknown) => e)

describe('the product client stub', () => {
  test('reads return the same loading objects every time, in the product shape', () => {
    const c = new HttpAgent()
    expect(c.read()).toBe(c.read())
    expect(c.getSnapshot()).toBe(c.getSnapshot())
    expect(c.listFiles()).toBe(c.listFiles())
    expect(c.listNotifications()).toBe(c.listNotifications())
    expect(c.allChatIds()).toBe(c.allChatIds())
    const data = AgentDataSchema.parse(c.read())
    expect(data.status).toBe('loading')
    AgentStateSchema.parse(c.getSnapshot())
    expect(Object.keys(c.read())).not.toContain('scenarios')
    expect(Object.keys(c.getSnapshot())).not.toContain('demoStartedAt')
    expect(c.read().tools).toMatchObject({ connection: {}, setup: [], readDone: 0 })
    expect(c.getTrace('any')).toBeNull()
  })

  test.each(WRITES)('%s rejects with AgentError("unavailable") and sends one error notice', async (_name, call) => {
    const c = new HttpAgent()
    const heard: AgentNotice[] = []
    c.onNotice(n => heard.push(n))
    const e = await errorOf(call(c))
    expect(e).toBeInstanceOf(AgentError)
    expect((e as AgentError).code).toBe('unavailable')
    expect(heard).toEqual([{ type: 'error', code: 'unavailable', text: (e as AgentError).message }])
  })

  test('a listener that unsubscribed hears nothing', async () => {
    const c = new HttpAgent()
    const heard: AgentNotice[] = []
    const off = c.onNotice(n => heard.push(n))
    off()
    await errorOf(c.setToggle('k', true))
    expect(heard).toEqual([])
  })

  test('ask never starts a run: its first event rejects with AgentError("unavailable"), and no write notice is sent', async () => {
    const c = new HttpAgent()
    const heard: AgentNotice[] = []
    c.onNotice(n => heard.push(n))
    const it = c.ask('Which orders are stuck?', { chatId: 'c' })[Symbol.asyncIterator]()
    const e = await errorOf(it.next())
    expect(e).toBeInstanceOf(AgentError)
    expect((e as AgentError).code).toBe('unavailable')
    expect(heard).toEqual([])
  })
})
