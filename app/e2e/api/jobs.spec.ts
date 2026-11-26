// Long jobs on the sandbox deploy (Stage 1 M1-D, N3 and N4), with short timings: a chat turn the server cuts becomes a
// job, carries on with the tab closed, survives a container killed while a step runs, and ends with one result and one
// bell notice; Cancel ends a job between its turns and on a live turn. Every case runs turns, so `needsContainer()`.
// Oracles: N3, N4 and the scripted chain (`long-job-run`, test/scripted-model/scenarios/jobs.ts): three steps of 20
// seconds, each call id carrying the run's token. With JOB_CUT_MS at 50 s the root does two steps and is cut in the third
// (three can't fit, two always do), so it becomes a job and a continuation finishes it.
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
import { killRunners, resetJobTimings, setJobTimings } from './job-kit.ts'
import { jobNotices, jobWhen, onlyThePersonSpeaks, outputText, runToken, runningStep, stepsOf, storedJob, storedMessages } from './job-proof.ts'
import { actor, call } from './kit.ts'

const dana = actor('memberA')
const release = actor('release')
const JOB_CUT_MS = 50_000
test.describe.configure({ mode: 'serial' })

/** A job of the token chain, started by dana's message in a new chat. */
async function startRun(request: APIRequestContext) {
  const token = runToken()
  const text = `scenario:long-job-run run=${token} Do the three steps.`
  const chatId = await createChat(request, dana)
  const sent = await send(request, dana, chatId, text)
  return { chatId, text, sent, prefix: stepIdPrefix('run', token) }
}

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
  test.setTimeout(12 * 60_000)
  await setJobTimings(request, { JOB_CUT_MS })
  try {
    const tab = await Tab.open(dana)
    const { chatId, text, sent, prefix } = await startRun(request)
    tab.attach(sent.runId)
    await tab.until(() => tab.frames(sent.runId).some(f => f.event.type === 'job.started'), 'the job started', 180_000)
    const frames = tab.frames(sent.runId)
    const started = frames.find(f => f.event.type === 'job.started')!.event
    expect(started.rootTurnId).toBe(sent.turnId)
    // The root ended at the server's cut, right before its job started: not done, not a failure the person must act on.
    expect(frames.find(f => f.event.type === 'turn.finished' && f.event.turnId === sent.turnId)?.event.outcome).toBe('interrupted')
    tab.close()

    // A continuation's step running now (the root's steps are known): kill every runner under it.
    const before = await stepsOf(request, prefix)
    const step = await runningStep(request, prefix, new Set(before.calls), 4 * 60_000)
    expect(await killRunners(request)).not.toEqual([])

    const job = await jobWhen(request, dana, chatId, j => j.state === 'ended', 'the job ended', 8 * 60_000)
    expect(job).toMatchObject({ jobId: started.jobId, rootTurnId: sent.turnId, outcome: 'done' })
    // The killed step came back as an error (the SDK's "interrupted" result on the resumed session) and ran again; every
    // step has exactly one successful run.
    const after = await stepsOf(request, prefix)
    expect(after.results.get(step), `the killed step ${step}'s result`).toBe(true)
    const ok = after.calls.filter(id => after.results.get(id) === false).map(id => id.slice(prefix.length).split('_')[0])
    expect(ok.sort()).toEqual(['1', '2', '3'])

    const messages = await storedMessages(request, dana, chatId)
    expect(messages.filter(m => m.role === 'agent' && m.part?.type === 'text' && m.part.text === JOB_RUN_DONE), 'one result').toHaveLength(1)
    onlyThePersonSpeaks(messages, text)
    expect(messages.filter(m => m.role === 'event' && m.text === JOB_CARRIED_ON_TEXT).length, 'continuations read as the agent carrying on').toBeGreaterThanOrEqual(2)
    // The root's cut keeps no end row: a reload shows no "You stopped" or failure for it.
    expect(messages.filter(m => m.turnId === sent.turnId && m.role === 'event')).toEqual([])
    await expect.poll(async () => (await jobNotices(request, dana, job.jobId)).length, { timeout: 60_000, message: 'the job\'s one notice' }).toBe(1)
    // The file the steps wrote: the root's lines (saved at its end, before the kill) are in it, and it ends at step 3.
    const lines = (await outputText(request, dana, chatId, JOB_RUN_FILE)).trim().split('\n')
    expect(lines[0]).toBe('step-1')
    expect(lines.at(-1)).toBe('step-3')
    await runFinished(request, chatId)
    expect((await jobNotices(request, dana, job.jobId)).length).toBe(1)
  } finally {
    await resetJobTimings(request)
  }
})

test('Cancel on a live turn stops it and ends the job: no later turn, one notice', async ({ request }) => {
  needsContainer()
  test.setTimeout(8 * 60_000)
  await setJobTimings(request, { JOB_CUT_MS })
  try {
    const { chatId, text, prefix } = await startRun(request)
    const running = await jobWhen(request, dana, chatId, j => j.state === 'running', 'the job started', 180_000)
    const before = await stepsOf(request, prefix)
    await runningStep(request, prefix, new Set(before.calls), 4 * 60_000)
    const r = await call(request, dana, 'POST', `/api/jobs/${running.jobId}/cancel`)
    expect(r.status, r.text).toBe(200)
    expect(r.json.job).toMatchObject({ jobId: running.jobId, state: 'ended', outcome: 'cancelled' })
    // Another person's Cancel is not found (the job is the chat owner's).
    const other = await call(request, actor('memberB'), 'POST', `/api/jobs/${running.jobId}/cancel`)
    expect(other.status, other.text).toBe(404)
    await runFinished(request, chatId)
    const messages = await storedMessages(request, dana, chatId)
    onlyThePersonSpeaks(messages, text)
    expect(messages.some(m => m.part?.text === JOB_RUN_DONE), 'no result after a Cancel').toBe(false)
    // The live continuation was stopped: its end row is the stopped note, as a person's Stop.
    const conts = [...new Set(messages.filter(m => m.role === 'event' && m.text === JOB_CARRIED_ON_TEXT).map(m => m.turnId))]
    expect(conts).toHaveLength(1)
    expect(messages.filter(m => m.turnId === conts[0] && m.id.endsWith('.x'))).toHaveLength(1)
    await expect.poll(async () => (await jobNotices(request, dana, running.jobId)).length, { timeout: 60_000, message: 'the job\'s one notice' }).toBe(1)
    expect((await storedJob(request, dana, chatId))?.outcome).toBe('cancelled')
  } finally {
    await resetJobTimings(request)
  }
})

test('Cancel between turns ends the job and no continuation ever starts', async ({ request }) => {
  needsContainer()
  test.setTimeout(8 * 60_000)
  // A drain refuses the continuation (the job waits to try again, here for 10 minutes), so the job sits between turns.
  await setJobTimings(request, { JOB_CUT_MS, JOB_RETRY_MS: 600_000 })
  let drained = false
  try {
    const { chatId, text, sent, prefix } = await startRun(request)
    await runningStep(request, prefix, new Set(), 3 * 60_000)
    const d = await call(request, release, 'POST', '/api/ops/drain', { json: {} })
    expect(d.status, d.text).toBe(200)
    drained = true
    const waiting = await jobWhen(request, dana, chatId, j => j.state === 'running', 'the root became a job', 180_000)
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
    const messages = await storedMessages(request, dana, chatId)
    onlyThePersonSpeaks(messages, text)
    expect(messages.filter(m => m.role === 'event' && m.text === JOB_CARRIED_ON_TEXT), 'no continuation').toEqual([])
    await expect.poll(async () => (await jobNotices(request, dana, waiting.jobId)).length, { timeout: 60_000, message: 'the job\'s one notice' }).toBe(1)
  } finally {
    if (drained) await call(request, release, 'DELETE', '/api/ops/drain')
    await resetJobTimings(request)
  }
})
