// The product-only behaviour of the Inhouse team window and the Tools page's Request, as pure decisions
// and one async flow, since the repo has no DOM test setup (no jsdom or testing library; adding one is an orchestrator
// change to package.json). Ways it can fail, written first:
//  - the product shows the screenshot box or the reply-time promise;
//  - a failed read of the open requests shows an empty list as if there were none;
//  - "Request sent" shows on the Tools page before the server has it, or after a refusal.
import { describe, expect, it } from 'vitest'
import { askForTool, requestsView, showScreenshotBox, teamHelper, sentToast, helpLine } from './product-flow'

const tick = () => new Promise<void>(r => setTimeout(r, 0))

describe('the team window', () => {
  it('the product has no screenshot box on a bug and no reply-time promise; the demo keeps both', () => {
    expect(showScreenshotBox(false, true)).toBe(false)
    expect(showScreenshotBox(false, false)).toBe(false)
    expect(showScreenshotBox(true, true)).toBe(true)
    expect(teamHelper(false, true)).toBe('')
    expect(teamHelper(false, false)).toBe('Every tool and job is included in your plan.')
    expect(teamHelper(true, true)).toBe('Goes straight to the team, with the page you were on.')
    expect(sentToast(true, false)).toContain('one working day')
    expect(sentToast(false, false)).toBe('Request sent to your Inhouse team.')
    expect(sentToast(false, true)).not.toMatch(/day|repl/)
  })
  it('the help window promises a reply time in the demo only', () => {
    expect(helpLine(true)).toContain('one working day')
    expect(helpLine(false)).toBe("Can't find it? Ask your Inhouse team.")
  })
  it('a failed read shows the error line with Retry, never an empty list; loading and ready show the list', () => {
    expect(requestsView({ status: 'error' })).toBe('error')
    expect(requestsView({ status: 'ready' })).toBe('list')
    expect(requestsView({ status: 'loading' })).toBe('list')
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
