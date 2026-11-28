// Unit and store tests for the demo's long jobs, helpers and web switches (Stage 1 PR 2: J1 to J8).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MockAgent } from './mock'
import type { RunEvent } from './types'

let storage: Map<string, string>
beforeEach(() => {
  storage = new Map()
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => { storage.set(k, v) },
    removeItem: (k: string) => { storage.delete(k) },
  })
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function load() {
  vi.resetModules()
  const store = await import('../state/store')
  const { agent } = await import('./index')
  await import('../screens/chat/run')
  await (agent as unknown as MockAgent).preload()
  return { store, mock: agent as unknown as MockAgent, ui: () => store.useUi.getState() }
}

const settle = () => vi.advanceTimersByTimeAsync(0)
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)

describe('demo seeded long jobs and bell notices (J2, J3, J4)', () => {
  test('catalog-audit returns a seeded running job with 2 helpers, Cancel ends it and notifies the bell', async () => {
    const l = await load()
    const job = await l.mock.job('catalog-audit')
    expect(job).toMatchObject({
      chatId: 'catalog-audit',
      state: 'running',
      outcome: null,
      progress: { label: 'Checking variant margins on Shopify', helpers: 2 },
    })

    const page = await l.mock.getChat('catalog-audit')
    expect(page.messages.some(m => m.role === 'event' && m.text === 'Your Inhouse agent carried on with this task by itself.')).toBe(true)

    const ended = await l.mock.cancelJob(job!.jobId)
    expect(ended).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    // Cancelling an already-ended job is idempotent.
    expect(await l.mock.cancelJob(job!.jobId)).toMatchObject({ state: 'ended', outcome: 'cancelled' })

    const notices = l.mock.listNotifications()
    expect(notices[0]).toMatchObject({
      text: 'A long job stopped. It was stopped before it finished.',
      unread: true,
      link: { to: 'chat', id: 'catalog-audit' },
    })
  })

  test('seasonal-restock ran 2 h 14 min and ad-spend-audit stopped at its budget; both seed quiet bell notices', async () => {
    const l = await load()
    const done = await l.mock.job('seasonal-restock')
    expect(done).toMatchObject({ state: 'ended', outcome: 'done' })
    expect(done!.endedAt!.ms - done!.startedAt.ms).toBe(134 * 60_000)

    const restockPage = await l.mock.getChat('seasonal-restock')
    const carryOns = restockPage.messages.filter(m => m.role === 'event')
    expect(carryOns).toHaveLength(2)

    const budget = await l.mock.job('ad-spend-audit')
    expect(budget).toMatchObject({ state: 'ended', outcome: 'budget' })

    const bellTexts = l.mock.listNotifications().map(n => n.text)
    expect(bellTexts).toContain('A long job finished')
    expect(bellTexts).toContain('A long job stopped')
  })

  test('First day hides seeded jobs and job notices', async () => {
    const l = await load()
    l.mock.setDemo({ stage: 'Act', scenario: 'First day' })
    expect(await l.mock.job('catalog-audit')).toBeNull()
    expect(l.mock.listNotifications()).toEqual([])
  })
})

describe('typed long tasks, Follow-up during running job, and Job budget (J1, J5)', () => {
  test('a typed long task runs as a long job with carry-on note and finishes on the demo clock', async () => {
    const l = await load()
    const events: RunEvent[] = []
    await l.mock.createChat({ id: 'typed-job', title: 'Catalog audit' })
    const sent = await l.mock.send('typed-job', { clientTurnKey: 'typed-long-task-1', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(60_000)
    off()

    const types = events.map(e => e.type)
    expect(types).toContain('job.started')
    expect(types).toContain('job.progress')
    expect(types).toContain('job.ended')
    const queuedCont = events.find(e => e.type === 'turn.queued' && e.source === 'job')
    expect(queuedCont).toBeDefined()
    expect(events.find(e => e.type === 'job.ended')).toMatchObject({ outcome: 'done' })

    const page = await l.mock.getChat('typed-job')
    expect(page.messages.some(m => m.role === 'event' && m.text === 'Your Inhouse agent carried on with this task by itself.')).toBe(true)
    expect(l.mock.listNotifications()[0]).toMatchObject({ text: 'A long job finished', unread: true, link: { to: 'chat', id: 'typed-job' } })
  })

  test('a low Job budget stops a typed long task with outcome budget', async () => {
    const l = await load()
    await l.mock.setSetting('s:job_cap', '$1')
    const events: RunEvent[] = []
    await l.mock.createChat({ id: 'cap-job', title: 'Budget stop' })
    const sent = await l.mock.send('cap-job', { clientTurnKey: 'budget-job-1', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(60_000)
    off()

    expect(events.find(e => e.type === 'job.ended')).toMatchObject({ outcome: 'budget' })
    expect(await l.mock.job('cap-job')).toMatchObject({ state: 'ended', outcome: 'budget' })
    expect(l.mock.listNotifications()[0]?.text).toContain('A long job stopped.')
  })

  test('Cancel job interrupts a freshly started live long job immediately', async () => {
    const l = await load()
    const events: RunEvent[] = []
    await l.mock.createChat({ id: 'cancel-live', title: 'Cancel live job' })
    const sent = await l.mock.send('cancel-live', { clientTurnKey: 'cancel-live-1', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(3_000)
    const liveJob = await l.mock.job('cancel-live')
    expect(liveJob?.state).toBe('running')
    await l.mock.cancelJob(liveJob!.jobId)
    await settle()
    await run(10_000)
    off()

    expect(events.find(e => e.type === 'job.ended')).toMatchObject({ outcome: 'cancelled' })
    expect(await l.mock.job('cancel-live')).toMatchObject({ state: 'ended', outcome: 'cancelled' })
  })

  test('asking a follow-up inside catalog-audit answers the question and keeps the job running (J5)', async () => {
    const l = await load()
    const events: RunEvent[] = []
    const sent = await l.mock.send('catalog-audit', { clientTurnKey: 'followup-audit-1', text: 'Which margin is lowest so far?', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(20_000)
    off()

    expect(await l.mock.job('catalog-audit')).toMatchObject({ state: 'running', progress: { label: 'Checking variant margins on Shopify', helpers: 2 } })
    const part = events.find(e => e.type === 'part')
    expect(part && part.type === 'part' && part.part.type === 'text' ? part.part.text : '').toContain('33% net margin')
  })
})

describe('helper traces and web switches (J6, J7, J8)', () => {
  test('helper traces include handoff and nested depth-1 agent steps', async () => {
    const l = await load()
    const tr = await l.mock.getTrace('catalog-audit-progress')
    expect(tr).not.toBeNull()
    expect(tr!.steps.some(s => s.kind === 'handoff' && s.label.includes('Asking a helper'))).toBe(true)
    expect(tr!.steps.some(s => s.kind === 'agent' && s.depth === 1)).toBe(true)
    expect(tr!.steps.some(s => s.depth === 2)).toBe(true)
  })

  test('Search the web, Read web pages, and Websites it may open change live answers', async () => {
    const l = await load()
    await l.mock.createChat({ id: 'web-test', title: 'Web test' })
    const ask = async (key: string, text: string) => {
      const evs: RunEvent[] = []
      const s = await l.mock.send('web-test', { clientTurnKey: key, text, model: 'opus' })
      const off = l.mock.attach(s.runId, f => evs.push(f.event))
      await run(20_000)
      off()
      return evs.filter(e => e.type === 'part').map(e => (e.type === 'part' && e.part.type === 'text' ? e.part.text : '')).join('\n')
    }

    // Search the web defaults to off.
    expect(await ask('web-key-01', 'Search the web for competitor prices on insulated bottles')).toContain('Search the web is turned off in Settings')

    // Turn on Search the web, with empty allowed hosts -> snippets only.
    await l.mock.setToggle('t:websearch', true)
    expect(await ask('web-key-02', 'Search the web for competitor prices on insulated bottles')).toContain('Websites it may open is empty')

    // Add allowed host and ask -> checks the listed host and links it.
    await l.mock.setSetting('t:webfetch', 'trailgear.example.test')
    const ok = await ask('web-key-03', 'Search the web for competitor prices on insulated bottles')
    expect(ok).toContain('[trailgear.example.test](https://trailgear.example.test/)')

    // Turn off Read web pages -> blocks direct URL fetch.
    await l.mock.setToggle('t:webfetch_on', false)
    expect(await ask('web-key-04', 'Check https://trailgear.example.test/bottles')).toContain('Read web pages is turned off in Settings')
  })
})
