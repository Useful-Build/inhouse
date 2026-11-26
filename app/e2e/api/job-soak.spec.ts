// M1's 2-hour proof (Stage 1 M1-D, N3 and N4; master plan M1's first done-when line): a scripted job whose steps alone
// take 2 hours runs on the sandbox deploy with real timings and no tab, a container is killed under it while a step runs,
// and it still ends with one result and one notice. API only: no socket is ever opened, so no tab is.
//
// Why one spec and not a start and a later check: every sandbox-test-deploy dispatch tears PR N's deployment down and
// deploys it again (scripts/sandbox/deploy.mjs), so a second dispatch 2 hours later would check a fresh, empty one.
// Within one dispatch the specs job has 210 minutes (#452), about 199 of them after the build, deploy and warm-up: room
// for the job (2 hours of sleeps plus its turns' overheads, about 135 minutes) and the checks. It runs ONLY when named:
//   gh workflow run sandbox-test-deploy -R Useful-Build/inhouse --ref main -f pr=<N> -f sha=<head> -f full=true -f only="api/job-soak.spec.ts"
// It reads the workflow's `only` list (the step's ONLY environment) for its own name, and skips everywhere else (the
// required test-build job, the default agent set and a full run without `only`), so no other run waits 2 hours.
//
// It would fail if: the job ended before 2 hours or not `done`; the kill didn't land while a step ran, or the job didn't
// go on after it on a new container (the killed step comes back as an error on the resumed session, and later steps
// run); the result file lost the work done before the kill; the job ended with no result, two, or a second notice; a
// server-written turn read as the person's message.
import { expect, test } from '@playwright/test'
import { JOB_CARRIED_ON_TEXT } from '../../shared/server-turn-text.ts'
import { SOAK_DONE, SOAK_FILE, SOAK_STEPS, stepIdPrefix } from '../../test/scripted-model/scenarios/jobs.ts'
import { createChat, send } from './chat-kit.ts'
import { killRunners } from './job-kit.ts'
import { jobNotices, jobWhen, onlyThePersonSpeaks, outputText, runToken, runningStep, stepsOf, storedMessages } from './job-proof.ts'
import { actor } from './kit.ts'

const SELF = 'api/job-soak.spec.ts'
const asked = (process.env.ONLY ?? '').split(/\s+/).includes(SELF)
const dana = actor('memberA')
const TWO_HOURS_MS = 2 * 60 * 60_000
/** The spec's own limit: inside pr-code's 210 minutes less its ~11 of build, deploy and warm-up. */
const SOAK_TIMEOUT_MS = 190 * 60_000
/** When the kill comes: well inside the job, after it has carried on at least once. */
const KILL_AFTER_MS = 55 * 60_000

test('a scripted 2-hour job survives a closed tab and a killed container and ends with one result and one notice', async ({ request }) => {
  test.skip(!asked, `the 2-hour proof runs only when named: sandbox-test-deploy -f full=true -f only="${SELF}"`)
  test.setTimeout(SOAK_TIMEOUT_MS)
  const token = runToken()
  const prefix = stepIdPrefix('soak', token)
  const text = `scenario:long-job-soak run=${token} Do every soak step.`
  const chatId = await createChat(request, dana)
  const t0 = Date.now()
  const sent = await send(request, dana, chatId, text)

  // The root turn hits its limit (its steps or the 25-minute cut) and becomes a job; then it carries on by itself.
  const job = await jobWhen(request, dana, chatId, j => j.state === 'running', 'the root became a job', 40 * 60_000)
  expect(job.rootTurnId).toBe(sent.turnId)
  await expect.poll(async () => Date.now() - t0 >= KILL_AFTER_MS && (await storedMessages(request, dana, chatId)).some(m => m.text === JOB_CARRIED_ON_TEXT),
    { timeout: KILL_AFTER_MS + 30 * 60_000, intervals: [60_000], message: 'the job ran on past the kill time and carried on at least once' }).toBe(true)

  // Kill every runner while one of this job's steps runs (a call with no result yet).
  const before = await stepsOf(request, prefix)
  const done = new Set(before.calls.filter(id => before.results.has(id)))
  const step = await runningStep(request, prefix, done, 5 * 60_000)
  const killed = await killRunners(request)
  const killedAtMs = Date.now()
  expect(killed).not.toEqual([])
  const stepN = Number(step.slice(prefix.length).split('_')[0])

  const ended = await jobWhen(request, dana, chatId, j => j.state === 'ended', 'the job ended', SOAK_TIMEOUT_MS - (Date.now() - t0) - 3 * 60_000)
  const ranMs = ended.endedAt!.ms - ended.startedAt.ms
  expect(ended.outcome).toBe('done')
  expect(ranMs, 'the job ran 2 hours').toBeGreaterThanOrEqual(TWO_HOURS_MS)

  // The container under the killed step was gone: the resumed session gave its call an error result, and the job went on
  // (on a new container) to run every later step once.
  const after = await stepsOf(request, prefix)
  expect(after.results.get(step), `the killed step ${step}'s result`).toBe(true)
  const okSteps = after.calls.filter(id => after.results.get(id) === false).map(id => Number(id.slice(prefix.length).split('_')[0]))
  expect([...okSteps].sort((a, b) => a - b), 'every step ran once to success').toEqual(Array.from({ length: SOAK_STEPS }, (_, i) => i + 1))
  expect(okSteps.filter(n => n > stepN).length, 'steps after the kill').toBe(SOAK_STEPS - stepN)

  // The result file holds work from before the kill (the first steps, saved at earlier turns' ends) and ends at the last
  // step, in order. A step done in the killed turn after its last save may be missing (N4: files since the last save are
  // lost), so gaps are counted, not refused.
  const lines = (await outputText(request, dana, chatId, SOAK_FILE)).trim().split('\n')
  const nums = lines.map(l => Number(/^step-(\d+)$/.exec(l)?.[1]))
  expect(nums.every(Number.isInteger), `the file's lines: ${lines.slice(0, 5).join(',')}...`).toBe(true)
  expect(nums[0]).toBe(1)
  expect(nums.at(-1)).toBe(SOAK_STEPS)
  expect(nums.some(n => n < stepN), 'lines written before the kill').toBe(true)
  for (let i = 1; i < nums.length; i++) expect(nums[i]!, `line ${i + 1} after line ${i}`).toBeGreaterThan(nums[i - 1]!)

  const messages = await storedMessages(request, dana, chatId)
  expect(messages.filter(m => m.role === 'agent' && m.part?.type === 'text' && m.part.text === SOAK_DONE), 'one result').toHaveLength(1)
  onlyThePersonSpeaks(messages, text)
  await expect.poll(async () => (await jobNotices(request, dana, ended.jobId)).length, { timeout: 120_000, message: 'the job\'s one notice' }).toBe(1)

  // For the PR: the soak's numbers.
  console.log(`M1-D soak ${JSON.stringify({
    jobId: ended.jobId, ranMinutes: Math.round(ranMs / 60_000), killedAfterMinutes: Math.round((killedAtMs - t0) / 60_000), killed, killedStep: stepN,
    continuations: new Set(messages.filter(m => m.text === JOB_CARRIED_ON_TEXT).map(m => m.turnId)).size,
    fileLines: nums.length, missingLines: SOAK_STEPS - nums.length, costMinor: ended.cost?.minor ?? null,
  })}`)
})
