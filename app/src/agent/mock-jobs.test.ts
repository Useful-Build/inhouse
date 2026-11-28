// Unit and store tests for the demo's long jobs, helpers and web switches (Stage 1 PR 2: J1 to J8).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { MockAgent } from './mock'
import type { RunEvent, RunFrame } from './types'
import { JobSchema } from '../../shared/contract/jobs'
import { ChatPageSchema } from '../../shared/contract/chats'
import { RunFrameSchema } from '../../shared/contract/run-event'

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
      icon: 'error',
      text: 'A long job stopped',
      unread: true,
      link: { to: 'chat', id: 'catalog-audit' },
    })

    // Issue 637: marking the live job notice read flips unread to false.
    await l.mock.markNoticesRead([notices[0].id])
    expect(l.mock.listNotifications().find(n => n.id === notices[0].id)?.unread).toBe(false)
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

    const notices = l.mock.listNotifications()
    expect(notices.find(n => n.text === 'A long job finished')).toMatchObject({ icon: 'check', link: { to: 'chat', id: 'seasonal-restock' } })
    expect(notices.find(n => n.text === 'A long job stopped')).toMatchObject({ icon: 'error', link: { to: 'chat', id: 'ad-spend-audit' } })
  })

  test('seeded lazy job and web chats match JobSchema and ChatPageSchema (issue 639)', async () => {
    const l = await load()
    for (const chatId of ['catalog-audit', 'seasonal-restock', 'ad-spend-audit', 'competitor-prices']) {
      const page = await l.mock.getChat(chatId)
      expect(() => ChatPageSchema.parse(page)).not.toThrow()
      const job = await l.mock.job(chatId)
      if (chatId === 'competitor-prices') expect(job).toBeNull()
      else expect(() => JobSchema.parse(job)).not.toThrow()
    }
  })

  test('First day hides seeded jobs and job notices', async () => {
    const l = await load()
    l.mock.setDemo({ stage: 'Act', scenario: 'First day' })
    expect(await l.mock.job('catalog-audit')).toBeNull()
    expect(l.mock.listNotifications()).toEqual([])
  })
})

describe('typed long tasks, Follow-up during running job, and Job budget (J1, J5)', () => {
  test('a typed long task finishes Turn 0 at max_turns, steps helpers 2 -> 1 -> 0 over 24s, and satisfies RunFrameSchema/JobSchema/ChatPageSchema', async () => {
    const l = await load()
    const frames: RunFrame[] = []
    await l.mock.createChat({ id: 'typed-job', title: 'Catalog audit' })
    const sent = await l.mock.send('typed-job', { clientTurnKey: 'typed-long-task-1', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => frames.push(f))
    await run(60_000)
    off()

    for (const f of frames) expect(() => RunFrameSchema.parse(f)).not.toThrow()
    const events = frames.map(f => f.event)
    const rootIdx = events.findIndex(e => e.type === 'turn.finished' && e.turnId === sent.turnId)
    const startIdx = events.findIndex(e => e.type === 'job.started')
    expect(rootIdx).toBeGreaterThan(-1)
    expect(events[rootIdx]).toMatchObject({ type: 'turn.finished', outcome: 'failed', reason: 'max_turns' })
    expect(startIdx).toBeGreaterThan(rootIdx)

    const rootText = events.filter(e => e.type === 'part' && e.turnId === sent.turnId).map(e => (e.type === 'part' && e.part.type === 'text' ? e.part.text : '')).join('\n')
    expect(rootText).not.toContain('Opened a long job')

    const progress = events.filter((e): e is Extract<RunEvent, { type: 'job.progress' }> => e.type === 'job.progress')
    expect(progress.map(p => p.helpers)).toEqual([2, 1, 0])
    expect(events.find(e => e.type === 'turn.queued' && e.source === 'job')).toBeDefined()
    expect(events.find(e => e.type === 'job.ended')).toMatchObject({ outcome: 'done' })

    const page = await l.mock.getChat('typed-job')
    const typedJob = await l.mock.job('typed-job')
    expect(() => ChatPageSchema.parse(page)).not.toThrow()
    expect(() => JobSchema.parse(typedJob)).not.toThrow()
    expect(page.messages.some(m => m.role === 'event' && m.text === 'Your Inhouse agent carried on with this task by itself.')).toBe(true)
    expect(l.mock.listNotifications()[0]).toMatchObject({ icon: 'check', text: 'A long job finished', unread: true, link: { to: 'chat', id: 'typed-job' } })
  })

  test('typed long task starts cleanly a second time in the same chat and after an ended seeded job (H1)', async () => {
    const l = await load()
    await l.mock.createChat({ id: 'two-jobs', title: 'Two jobs' })
    const s1 = await l.mock.send('two-jobs', { clientTurnKey: 'two-jobs-key-01', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    await run(60_000)
    const j1 = await l.mock.job('two-jobs')
    expect(j1?.state).toBe('ended')

    const s2 = await l.mock.send('two-jobs', { clientTurnKey: 'two-jobs-key-02', text: 'Run a deep audit on drinkware', model: 'opus' })
    await run(60_000)
    const j2 = await l.mock.job('two-jobs')
    expect(s2.turnId).not.toBe(s1.turnId)
    expect(j2?.jobId).not.toBe(j1?.jobId)
    expect(j2).toMatchObject({ state: 'ended', outcome: 'done' })

    const audit = await l.mock.job('catalog-audit')
    await l.mock.cancelJob(audit!.jobId)
    await l.mock.send('catalog-audit', { clientTurnKey: 'reopen-audit-01', text: 'Run a deep audit on packs', model: 'opus' })
    await run(60_000)
    expect(await l.mock.job('catalog-audit')).toMatchObject({ state: 'ended', outcome: 'done' })
  })

  test('a low Job budget stops a typed long task with outcome budget (including $1.20 <= $1.45)', async () => {
    const l = await load()
    await l.mock.setSetting('s:job_cap', '$1.20')
    const events: RunEvent[] = []
    await l.mock.createChat({ id: 'cap-job', title: 'Budget stop' })
    const sent = await l.mock.send('cap-job', { clientTurnKey: 'budget-job-1', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(60_000)
    off()

    expect(events.find(e => e.type === 'job.ended')).toMatchObject({ outcome: 'budget' })
    expect(await l.mock.job('cap-job')).toMatchObject({ state: 'ended', outcome: 'budget' })
    expect(l.mock.listNotifications()[0]).toMatchObject({ icon: 'error', text: 'A long job stopped' })
  })

  test('Cancel job interrupts a freshly started live long job immediately', async () => {
    const l = await load()
    const events: RunEvent[] = []
    await l.mock.createChat({ id: 'cancel-live', title: 'Cancel live job' })
    const sent = await l.mock.send('cancel-live', { clientTurnKey: 'cancel-live-1', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(5_000)
    const liveJob = await l.mock.job('cancel-live')
    expect(liveJob?.state).toBe('running')
    await l.mock.cancelJob(liveJob!.jobId)
    await settle()
    await run(10_000)
    off()

    expect(events.find(e => e.type === 'job.ended')).toMatchObject({ outcome: 'cancelled' })
    expect(await l.mock.job('cancel-live')).toMatchObject({ state: 'ended', outcome: 'cancelled' })
  })

  test('cancelling mid-follow-up never emits a stale job.progress after cancellation (issue 643)', async () => {
    const l = await load()
    const events: RunEvent[] = []
    const audit = await l.mock.job('catalog-audit')
    const sent = await l.mock.send('catalog-audit', { clientTurnKey: 'followup-cancel-1', text: 'Which margin is lowest so far?', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(200)
    await l.mock.cancelJob(audit!.jobId)
    await run(10_000)
    off()

    expect(events.filter(e => e.type === 'job.progress')).toEqual([])
    expect(await l.mock.job('catalog-audit')).toMatchObject({ state: 'ended', outcome: 'cancelled' })
  })

  test('interrupting a helper continuation step does not finish as done', async () => {
    const l = await load()
    const events: RunEvent[] = []
    await l.mock.createChat({ id: 'interrupt-job', title: 'Interrupt job' })
    const sent = await l.mock.send('interrupt-job', { clientTurnKey: 'interrupt-job-01', text: 'Run a full catalog audit across every SKU', model: 'opus' })
    const off = l.mock.attach(sent.runId, f => events.push(f.event))
    await run(12_000)
    const queuedCont = events.find((e): e is Extract<RunEvent, { type: 'turn.queued' }> => e.type === 'turn.queued' && e.source === 'job')
    expect(queuedCont).toBeDefined()
    await l.mock.interrupt(queuedCont!.turnId)
    await run(30_000)
    off()

    const contEnd = events.find(e => e.type === 'turn.finished' && e.turnId === queuedCont!.turnId)
    expect(contEnd).toMatchObject({ outcome: 'interrupted' })
    expect(events.find(e => e.type === 'job.ended')).toMatchObject({ outcome: 'cancelled' })
    expect(events.some(e => e.type === 'part' && e.turnId === queuedCont!.turnId)).toBe(false)
  })

  test('deleting a chat during a live job aborts the job without done or a bell notice', async () => {
    const l = await load()
    for (const [chatId, delayMs] of [['del-between', 5_000], ['del-mid-step', 12_000]] as const) {
      const beforeNotices = l.mock.listNotifications().length
      const events: RunEvent[] = []
      await l.mock.createChat({ id: chatId, title: chatId })
      const sent = await l.mock.send(chatId, { clientTurnKey: `del-key-${chatId}`, text: 'Run a full catalog audit across every SKU', model: 'opus' })
      const off = l.mock.attach(sent.runId, f => events.push(f.event))
      await run(delayMs)
      await l.mock.deleteChats([chatId])
      await run(60_000)
      off()

      expect(events.find(e => e.type === 'job.ended')?.outcome).not.toBe('done')
      expect(events.some(e => e.type === 'run.finished')).toBe(true)
      expect(l.mock.listNotifications().length).toBe(beforeNotices)
    }
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

  test('Regenerate on lazy job and web chats replays each seeded opening answer (issues 636 and 644)', async () => {
    const l = await load()
    const replay = async (chatId: string, q: string) => {
      const events: RunEvent[] = []
      const sent = await l.mock.send(chatId, { clientTurnKey: `regen-${chatId}-1`, text: q, model: 'opus' })
      const off = l.mock.attach(sent.runId, f => events.push(f.event))
      await run(15_000)
      off()
      const tr = await l.mock.getTrace(sent.turnId)
      const parts = events.filter((e): e is Extract<RunEvent, { type: 'part' }> => e.type === 'part').map(e => e.part)
      return { parts, traceTitle: tr?.title }
    }

    const bottles = await replay('competitor-prices', "Compare competitor prices for 750ml insulated bottles before Friday's email.")
    expect(bottles.parts.map(p => p.type)).toEqual(['table', 'text'])
    expect(bottles.traceTitle).toBe('Compare competitor prices for 750ml insulated bottles')

    const restock = await replay('seasonal-restock', 'Build a full restock plan across Shopify, ShipBob and open purchase orders for every SKU under 30 days of cover.')
    expect(restock.parts[0]).toMatchObject({ type: 'text' })
    expect(restock.traceTitle).toBe('Pull stock on hand across stores')

    const ads = await replay('ad-spend-audit', 'Compare every Meta Ads campaign over the last 90 days by contribution margin after returns and shipping.')
    expect(ads.parts[0]).toMatchObject({ type: 'text' })
    expect(ads.traceTitle).toBe('Audit 90-day Meta Ads contribution margin')

    const audit = await l.mock.job('catalog-audit')
    await l.mock.cancelJob(audit!.jobId)
    const auditReplay = await replay('catalog-audit', 'Audit gross margin across every SKU, factor in shipping and ad spend, and flag any variant under 35%.')
    expect(auditReplay.parts[0]).toMatchObject({ type: 'text' })
    expect(auditReplay.traceTitle).toBe('Audit gross margin across every SKU')
    expect(await l.mock.job('catalog-audit')).toMatchObject({ state: 'ended', outcome: 'cancelled' })
  })
})

describe('helper traces and web switches (J6, J7, J8)', () => {
  test('helper traces include handoff, Researcher (Sonnet) reading apps, and Analyst (Opus) with Bash only (H2)', async () => {
    const l = await load()
    const tr = await l.mock.getTrace('catalog-audit-progress')
    expect(tr).not.toBeNull()
    expect(tr!.steps.some(s => s.kind === 'handoff' && s.label.includes('Asking a helper'))).toBe(true)
    expect(tr!.steps.some(s => s.kind === 'agent' && s.depth === 1 && s.label.startsWith('Researcher'))).toBe(true)
    expect(tr!.steps.some(s => s.kind === 'agent' && s.depth === 1 && s.label.startsWith('Analyst'))).toBe(true)
    expect(tr!.steps.some(s => s.kind === 'tool' && s.depth === 2 && s.label.startsWith('Bash ·'))).toBe(true)
    expect(tr!.steps.some(s => s.kind === 'model' && s.detail.startsWith('Sonnet 5.5'))).toBe(true)
    expect(tr!.steps.filter(s => s.kind === 'model').at(-1)?.detail.startsWith('Opus 5.5')).toBe(true)
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
