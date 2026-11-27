// Long jobs on the sandbox deploy (Stage 1 M1-D, N3 and N4), with short timings: a chat turn the server cuts becomes a
// job, carries on with the tab closed, survives a container killed while a step runs, and ends with one result and one
// bell notice; Cancel ends a job between its turns and on a live turn. Every case runs turns, so `needsContainer()`.
// Oracles: N3, N4 and the scripted chain (`long-job-run`, test/scripted-model/scenarios/jobs.ts): three steps of 60
// seconds, each call id carrying the run's token. With JOB_CUT_MS at 150 s the root does two steps and is cut in the
// third (three can't fit, two always do), so it becomes a job and a continuation finishes it.
// It would fail if: a cut turn didn't become a job; a closed tab or a killed container ended the job, lost the steps the
// store held or ran a done step again; a job ended with no result, two, or a second notice; a server-written turn read
// as the person's message, or its Try again as the person's question; Cancel left a turn running or a continuation
// started after it.
// `setJobTimings`, `killRunners` and the drain are brand-global (job-kit.ts): the cases run one at a time and put the
// timings and the drain back in a `finally`.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { JOB_CARRIED_ON_TEXT } from '../../shared/server-turn-text.ts'
import { JOB_RUN_DONE, JOB_RUN_FILE, stepIdPrefix } from '../../test/scripted-model/scenarios/jobs.ts'
import { Tab, createChat, needsContainer, send } from './chat-kit.ts'
import { killRunners, observeAgent, resetJobTimings, setJobTimings } from './job-kit.ts'
import { LOST_CALL, explainJob, jobNotices, jobWhen, onlyThePersonSpeaks, outputText, runToken, runnerGens, runningStep, stepsOf, storedJob, storedMessages, tryOf } from './job-proof.ts'
import { actor, call } from './kit.ts'

const dana = actor('memberA')
const release = actor('release')
const JOB_CUT_MS = 150_000
/** How long after the cut the BrandAgent is first observed: the wait before it stays a silent socket (see below). */
const OBSERVE_AFTER_CUT_MS = 30_000
test.describe.configure({ mode: 'serial' })

// The kept overrides start clear (#460 review): a run that died before a `finally` can't leave a short cut for these.
test.beforeAll(async ({ request }) => {
  if (!process.env.E2E_TEST_BUILD_REMOTE) return
  await resetJobTimings(request)
})

/** A job of the token chain, started by dana's message in a new chat. */
async function startRun(request: APIRequestContext) {
  const token = runToken()
  const text = `scenario:long-job-run run=${token} Do the three steps.`
  const chatId = await createChat(request, dana)
  const sent = await send(request, dana, chatId, text)
  return { chatId, text, sent, prefix: stepIdPrefix('run', token) }
}

/**
 * A continuation's step running now. The root makes each step's first call (try 0) and is cut in the third, so every
 * call a continuation makes runs a step again (try 1 or more). Found by that, never by "not stored when the job was
 * seen": the job is polled every few seconds and the continuation's call can be stored about 6 seconds after the job
 * starts, so a snapshot taken after it excluded the continuation's only step (sandbox run 45932254210).
 */
const continuationStep = (request: APIRequestContext, prefix: string): Promise<string> =>
  runningStep(request, prefix, id => tryOf(prefix, id) === 0, 6 * 60_000)

/** The chat's live run is gone from route 32 (it finished). */
async function runFinished(request: APIRequestContext, chatId: string) {
  await expect.poll(async () => {
    const r = await call(request, dana, 'GET', '/api/runs/active')
    expect(r.status, r.text).toBe(200)
    return (r.json.runs as { chatId: string; live: boolean }[]).some(x => x.chatId === chatId && x.live)
  }, { timeout: 120_000, message: `chat ${chatId}'s run finished` }).toBe(false)
}

test('a cut turn becomes a job that carries on with the tab closed, survives a killed container mid-step and ends with one result and one notice', async ({ request }) => {
  needsContainer()
  test.setTimeout(16 * 60_000)
  const timingsSetAtMs = Date.now()
  await setJobTimings(request, { JOB_CUT_MS })
  try {
    const tab = await Tab.open(dana)
    const { chatId, text, sent, prefix } = await startRun(request)
    tab.attach(sent.runId)
    // Until the cut is due the wait is a silent socket, as before #460, so the BrandAgent may still go idle and be rebuilt
    // (the path the kept timings exist for). Only after it, route 67's observe is polled: its isolate, the timings in
    // effect and the root's cut facts, printed with a failure so a cut that never came says why (#454 and #455).
    const jobStarted = () => tab.frames(sent.runId).some(f => f.event.type === 'job.started')
    const series: Record<string, unknown>[] = []
    try {
      await tab.until(jobStarted, 'the job started', JOB_CUT_MS + OBSERVE_AFTER_CUT_MS).catch(() => {})
      await expect.poll(async () => {
        series.push(await observeAgent(request, sent.turnId))
        return jobStarted()
      }, { timeout: 300_000 - JOB_CUT_MS - OBSERVE_AFTER_CUT_MS, intervals: [10_000], message: 'the job started' }).toBe(true)
    } catch (err) {
      console.log(`M1-D jobs: no job.started.\n${await explainJob(request, dana, { chatId, turnId: sent.turnId, frames: tab.frames(sent.runId) as never, prefix })}`)
      console.log(`M1-D jobs: the BrandAgent, every 10 s after the cut:\n${series.map(o => JSON.stringify(o)).join('\n')}`)
      throw err
    }
    // One line on success too: whether the BrandAgent was rebuilt while the job was awaited (its construct time after the
    // timings were set), and the timings it read.
    console.log(`M1-D jobs: the BrandAgent at job.started: ${JSON.stringify(series.at(-1) ?? await observeAgent(request, sent.turnId))}; timings set at ${timingsSetAtMs}`)
    const frames = tab.frames(sent.runId)
    const started = frames.find(f => f.event.type === 'job.started')!.event
    expect(started.rootTurnId).toBe(sent.turnId)
    // The root ended at the server's cut, right before its job started: not done, not a failure the person must act on.
    expect(frames.find(f => f.event.type === 'turn.finished' && f.event.turnId === sent.turnId)?.event.outcome).toBe('interrupted')
    tab.close()

    // A continuation's step running now: kill every runner under it. Found by its try, not by "not stored before": see
    // `continuationStep`.
    const found = Date.now()
    const step = await continuationStep(request, prefix)
    const seenMs = Date.now() - found
    const gensBefore = await runnerGens(request)
    const killed = await killRunners(request)
    console.log(`M1-D jobs: step ${step} seen running after ${seenMs} ms of polling; killed ${JSON.stringify(killed)} ${Date.now() - found} ms after the poll began`)
    expect(killed).not.toEqual([])

    const job = await jobWhen(request, dana, chatId, j => j.state === 'ended', 'the job ended', 8 * 60_000)
    expect(job).toMatchObject({ jobId: started.jobId, rootTurnId: sent.turnId, outcome: 'done' })
    // The container was replaced: every container running at the kill was killed, so the job's later turns ran on a
    // runner that started a newer generation than it had then (read from its own storage; which runner the pool picks
    // isn't fixed, so any runner's counts). And the killed step came back with the SDK's own "session ended before this call's result was recorded" (a server cut's interrupt
    // says otherwise) and ran again; every step has exactly one successful run.
    const gensAfter = await runnerGens(request)
    expect(Object.keys(gensAfter).filter(r => gensAfter[r]! > (gensBefore[r] ?? 0)), `a runner started a new container after the kill (${JSON.stringify({ killed, gensBefore, gensAfter })})`).not.toEqual([])
    const after = await stepsOf(request, prefix)
    expect(after.results.get(step), `the killed step ${step}'s result`).toBe(true)
    expect(after.texts.get(step), `the killed step ${step}'s result text`).toMatch(LOST_CALL)
    const ok = after.calls.filter(id => after.results.get(id) === false).map(id => id.slice(prefix.length).split('_')[0])
    expect(ok.sort()).toEqual(['1', '2', '3'])

    const messages = await storedMessages(request, dana, chatId)
    expect(messages.filter(m => m.role === 'agent' && m.part?.type === 'text' && m.part.text === JOB_RUN_DONE), 'one result').toHaveLength(1)
    onlyThePersonSpeaks(messages, text)
    expect(messages.filter(m => m.role === 'event' && m.text === JOB_CARRIED_ON_TEXT).length, 'continuations read as the agent carrying on').toBeGreaterThanOrEqual(2)
    // The root's cut keeps no end row: a reload shows no "You stopped" or failure for it.
    expect(messages.filter(m => m.turnId === sent.turnId && m.role === 'event')).toEqual([])
    await expect.poll(async () => (await jobNotices(request, dana, chatId)).length, { timeout: 60_000, message: 'the job\'s one notice' }).toBe(1)
    // The file the steps wrote: the root's lines (saved at its end, before the kill) are in it, and it ends at step 3.
    const lines = (await outputText(request, dana, chatId, JOB_RUN_FILE)).trim().split('\n')
    expect(lines[0]).toBe('step-1')
    expect(lines.at(-1)).toBe('step-3')
    await runFinished(request, chatId)
    expect((await jobNotices(request, dana, chatId)).length).toBe(1)
  } finally {
    await resetJobTimings(request)
  }
})

test('Cancel on a live turn stops it and ends the job: no later turn, one notice', async ({ request }) => {
  needsContainer()
  test.setTimeout(12 * 60_000)
  await setJobTimings(request, { JOB_CUT_MS })
  try {
    const { chatId, text, sent, prefix } = await startRun(request)
    const running = await jobWhen(request, dana, chatId, j => j.state === 'running', 'the job started', 300_000)
    let step: string
    try {
      step = await continuationStep(request, prefix)
    } catch (err) {
      // Why no continuation step was seen running (#460's agent-set run): the chat, the job, the steps and the
      // BrandAgent's view of the root (its isolate, the timings in effect).
      console.log(`M1-D jobs (Cancel live): no running step.\n${await explainJob(request, dana, { chatId, turnId: sent.turnId, frames: [], prefix })}`)
      console.log(`M1-D jobs (Cancel live): the BrandAgent: ${JSON.stringify(await observeAgent(request, sent.turnId))}`)
      throw err
    }
    // Another person's Cancel is not found (the job is the chat owner's), and changes nothing: the job still runs.
    const other = await call(request, actor('memberB'), 'POST', `/api/jobs/${running.jobId}/cancel`)
    expect(other.status, other.text).toBe(404)
    expect((await storedJob(request, dana, chatId))?.state).toBe('running')
    const r = await call(request, dana, 'POST', `/api/jobs/${running.jobId}/cancel`)
    expect(r.status, r.text).toBe(200)
    expect(r.json.job).toMatchObject({ jobId: running.jobId, state: 'ended', outcome: 'cancelled' })
    await runFinished(request, chatId)
    // The live step itself was stopped: it never came back successful, and it is the only step a continuation called (a
    // later turn would have run step 3 again under a new call id).
    const after = await stepsOf(request, prefix)
    expect(after.results.get(step), `the cancelled step ${step}'s result (false is a success)`).not.toBe(false)
    expect(after.calls.filter(id => tryOf(prefix, id) > 0), `the continuations' step calls (all: ${after.calls.join(', ')})`).toEqual([step])
    const messages = await storedMessages(request, dana, chatId)
    onlyThePersonSpeaks(messages, text)
    expect(messages.some(m => m.part?.text === JOB_RUN_DONE), 'no result after a Cancel').toBe(false)
    // The live continuation was stopped: its end row is the stopped note, as a person's Stop.
    const conts = [...new Set(messages.filter(m => m.role === 'event' && m.text === JOB_CARRIED_ON_TEXT).map(m => m.turnId))]
    expect(conts).toHaveLength(1)
    expect(messages.filter(m => m.turnId === conts[0] && m.id.endsWith('.x'))).toHaveLength(1)
    await expect.poll(async () => (await jobNotices(request, dana, chatId)).length, { timeout: 60_000, message: 'the job\'s one notice' }).toBe(1)
    expect((await storedJob(request, dana, chatId))?.outcome).toBe('cancelled')
  } finally {
    await resetJobTimings(request)
  }
})

test('Cancel between turns ends the job and no continuation ever starts', async ({ request }) => {
  needsContainer()
  test.setTimeout(12 * 60_000)
  // A drain refuses the continuation, so the job sits between turns, trying again every 20 seconds (still refused).
  const RETRY_MS = 20_000
  await setJobTimings(request, { JOB_CUT_MS, JOB_RETRY_MS: RETRY_MS })
  let drained = false
  try {
    const { chatId, text, sent, prefix } = await startRun(request)
    await runningStep(request, prefix, new Set(), 4 * 60_000)
    const d = await call(request, release, 'POST', '/api/ops/drain', { json: {} })
    expect(d.status, d.text).toBe(200)
    drained = true
    const waiting = await jobWhen(request, dana, chatId, j => j.state === 'running', 'the root became a job', 300_000)
    // The root's rows are stored (it ended), and no continuation was admitted while drained.
    await expect.poll(async () => (await storedMessages(request, dana, chatId)).some(m => m.id === `${sent.turnId}.u`), { timeout: 60_000, message: 'the root\'s rows' }).toBe(true)
    const r = await call(request, dana, 'POST', `/api/jobs/${waiting.jobId}/cancel`)
    expect(r.status, r.text).toBe(200)
    expect(r.json.job).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    // A second Cancel answers the ended job as it is.
    const again = await call(request, dana, 'POST', `/api/jobs/${waiting.jobId}/cancel`)
    expect(again.json.job).toMatchObject({ state: 'ended', outcome: 'cancelled' })
    const u = await call(request, release, 'DELETE', '/api/ops/drain')
    expect(u.status, u.text).toBe(200)
    drained = false
    await runFinished(request, chatId)
    // Undrained, a retry that outlived the Cancel would start a continuation within 20 seconds. Watch for three retry
    // periods that none does: no carry-on row is stored and no new step call reaches the session store.
    const stepsAtCancel = (await stepsOf(request, prefix)).calls.length
    const watchFrom = Date.now()
    await expect.poll(async () => {
      const carried = (await storedMessages(request, dana, chatId)).filter(m => m.role === 'event' && m.text === JOB_CARRIED_ON_TEXT)
      const calls = (await stepsOf(request, prefix)).calls.length
      if (carried.length > 0 || calls > stepsAtCancel) throw new Error(`a continuation started after the Cancel: ${carried.length} carry-on rows, ${calls - stepsAtCancel} new step calls`)
      return Date.now() - watchFrom >= 3 * RETRY_MS
    }, { timeout: 3 * RETRY_MS + 60_000, intervals: [5_000], message: 'no continuation for three retry periods after the Cancel' }).toBe(true)
    const messages = await storedMessages(request, dana, chatId)
    onlyThePersonSpeaks(messages, text)
    expect(messages.filter(m => m.role === 'event' && m.text === JOB_CARRIED_ON_TEXT), 'no continuation').toEqual([])
    await expect.poll(async () => (await jobNotices(request, dana, chatId)).length, { timeout: 60_000, message: 'the job\'s one notice' }).toBe(1)
  } finally {
    if (drained) await call(request, release, 'DELETE', '/api/ops/drain')
    await resetJobTimings(request)
  }
})
