// The product-only behaviour of the Skills page, the Inhouse team window and the Tools page's Request, as pure decisions
// and one async flow, since the repo has no DOM test setup (no jsdom or testing library; adding one is an orchestrator
// change to package.json). Ways it can fail, written first:
//  - the product keeps the "By your team" tab or the "Works from" row it has no use for, or the demo loses them;
//  - the team window says "sent" (toast, clear, close) before the server has the request, or after it refused it;
//  - the demo waits for the mock, or the product shows the screenshot box, the reply-time promise or no count;
//  - a failed read of the open requests shows an empty list as if there were none;
//  - "Request sent" shows on the Tools page before the server has it, or after a refusal.
import { describe, expect, it } from 'vitest'
import { askForTool, counterText, requestsView, sendFromWindow, shownSkillTab, showScreenshotBox, skillFacts, skillTabs, teamHelper, windowIntro, sentToast, helpLine } from './product-flow'

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('the Skills page', () => {
  it('the product offers All and By Inhouse team only; the demo keeps all three', () => {
    expect(skillTabs(true).map(([k]) => k)).toEqual(['all', 'team', 'mine'])
    expect(skillTabs(false).map(([k]) => k)).toEqual(['all', 'team'])
  })
  it('a saved "By your team" tab shows as All on the product, and as itself in the demo', () => {
    expect(shownSkillTab(false, 'mine')).toBe('all')
    expect(shownSkillTab(false, 'team')).toBe('team')
    expect(shownSkillTab(true, 'mine')).toBe('mine')
  })
  it('"Works from" is dropped on the product at need 0, kept there above 0 and always in the demo; "Used" only when there is one', () => {
    const labels = (product: boolean, need: 0 | 1 | 2, used = '') => skillFacts(product, { used, by: 'Inhouse team', need }, n => `S${n}`).map(([k]) => k)
    expect(labels(false, 0)).toEqual(['Made by'])
    expect(labels(false, 1)).toEqual(['Made by', 'Works from'])
    expect(labels(true, 0)).toEqual(['Made by', 'Works from'])
    expect(labels(false, 0, 'Weekly')).toEqual(['Used', 'Made by'])
  })
})

describe('the team window', () => {
  it('the product has no screenshot box on a bug and no reply-time promise; the demo keeps both', () => {
    expect(showScreenshotBox(false, true)).toBe(false)
    expect(showScreenshotBox(false, false)).toBe(false)
    expect(showScreenshotBox(true, true)).toBe(true)
    expect(teamHelper(false, true)).toBe('')
    expect(teamHelper(false, false)).toBe('Every tool and job is included in your plan.')
    expect(teamHelper(true, true)).toBe('Goes straight to the team, with the page you were on.')
    expect(windowIntro(true)).toContain('one working day')
    expect(windowIntro(false)).not.toMatch(/day|repl/)
    expect(sentToast(true, false)).toContain('one working day')
    expect(sentToast(false, false)).toBe('Request sent to your Inhouse team.')
    expect(sentToast(false, true)).not.toMatch(/day|repl/)
  })
  it('the help window promises a reply time in the demo only', () => {
    expect(helpLine(true)).toContain('one working day')
    expect(helpLine(false)).toBe("Can't find it? Ask your Inhouse team.")
  })
  it('the counter reads "<n> of 1000"', () => {
    expect(counterText(0)).toBe('0 of 1000')
    expect(counterText(1000)).toBe('1000 of 1000')
  })
  it('a failed read shows the error line with Retry, never an empty list; loading and ready show the list', () => {
    expect(requestsView({ status: 'error' })).toBe('error')
    expect(requestsView({ status: 'ready' })).toBe('list')
    expect(requestsView({ status: 'loading' })).toBe('list')
  })
})

describe('sendFromWindow', () => {
  const calls = () => {
    const log: string[] = []
    return { log, sent: () => log.push('toast'), done: () => log.push('close') }
  }
  it('product: nothing is said, cleared or closed until the server answers; then toast and close', async () => {
    const { log, sent, done } = calls()
    let resolve!: () => void
    const p = sendFromWindow({ product: true, send: () => new Promise<void>(r => { resolve = r }), sent, done })
    await tick()
    expect(log).toEqual([])
    resolve()
    expect(await p).toBe('sent')
    expect(log).toEqual(['toast', 'close'])
  })
  it('product: a refusal keeps the window and the words (no toast, no close)', async () => {
    const { log, sent, done } = calls()
    expect(await sendFromWindow({ product: true, send: () => Promise.reject(new Error('refused')), sent, done })).toBe('kept')
    expect(log).toEqual([])
  })
  it('demo: toast and close at once, without waiting for the mock', async () => {
    const { log, sent, done } = calls()
    const never = new Promise<void>(() => {})
    expect(await sendFromWindow({ product: false, send: () => never, sent, done })).toBe('sent')
    expect(log).toEqual(['toast', 'close'])
  })
})

describe('askForTool', () => {
  it('product: the toast waits for the server and a refusal shows none', async () => {
    const log: string[] = []
    let resolve!: () => void
    askForTool({ product: true, request: () => new Promise<void>(r => { resolve = r }), say: () => log.push('toast') })
    await tick()
    expect(log).toEqual([])
    resolve()
    await tick()
    expect(log).toEqual(['toast'])
    const refused: string[] = []
    askForTool({ product: true, request: () => Promise.reject(new Error('refused')), say: () => refused.push('toast') })
    await tick()
    expect(refused).toEqual([])
  })
  it('demo: the toast is at once', () => {
    const log: string[] = []
    askForTool({ product: false, request: () => new Promise<void>(() => {}), say: () => log.push('toast') })
    expect(log).toEqual(['toast'])
  })
})
