import { expect, test, type APIRequestContext } from '@playwright/test'
import { LONG_JOB_DONE, LONG_JOB_READY } from '../../test/scripted-model/scenarios/jobs.ts'
import { Tab, answerOf, needsContainer, send, textOf } from './chat-kit.ts'
import { jobControl, killRunner, startJob } from './job-kit.ts'
import { actor, call } from './kit.ts'

interface Probe {
  session: string
  sessionId: string | null
  checkpointEntries: number
  checkpointUuidMatches: boolean
  entries: number
  state: string
  runner: string | null
  graceOver: number
  fenced: number
  openTokens: number
  outcome: string | null
  failure: string | null
  sawCheckpoint: number
}

const member = actor('memberA')
const probe = async (request: APIRequestContext, turnId: string, recover = false): Promise<Probe> =>
  (await jobControl(request, { action: 'crashResumeProbe', turnId, ...(recover ? { recover: true } : {}) })) as Probe

async function filesOf(request: APIRequestContext, chatId: string) {
  const r = await call(request, member, 'GET', `/api/chats/${chatId}/files`)
  expect(r.status, r.text).toBe(200)
  return r.json.items as { fileId: string; path: string }[]
}

test('W0-B variant A: resume from the existing verified checkpoint without changing the store', async ({ request }) => {
  needsContainer()
  test.setTimeout(540_000)
  const tab = await Tab.open(member)
  const turns: string[] = []
  try {
    const { chatId, turnId: root } = await startJob(request, member, 'scenario:long-job [w0-b-spike] Save the first checkpoint.')
    turns.push(root)
    await expect.poll(async () => (await probe(request, root)).state, { timeout: 180_000 }).toBe('ended')
    const first = await probe(request, root)
    expect(first).toMatchObject({ session: 'resumable', outcome: 'done', sawCheckpoint: 1, checkpointUuidMatches: true })
    expect(first.checkpointEntries).toBeGreaterThan(0)
    expect(first.entries).toBe(first.checkpointEntries)
    expect((await filesOf(request, chatId)).map(f => f.path)).toContain('outputs/job-seed.txt')

    const work = await send(request, member, chatId, 'scenario:long-job-work [w0-b-spike] Write another file and keep working.')
    turns.push(work.turnId)
    tab.attach(work.runId)
    await tab.until(() => tab.frames(work.runId).some(f => f.event.turnId === work.turnId && f.event.type === 'part' &&
      (f.event.part as { text?: string } | undefined)?.text === LONG_JOB_READY), 'the successful post-checkpoint write', 180_000)
    const running = await probe(request, work.turnId)
    expect(running).toMatchObject({ state: 'live', sessionId: first.sessionId, queryRan: 1 })
    expect(running.runner).toMatch(/^runner-\d+$/)
    if (running.runner === null) throw new Error('missing runner for the live spike turn')
    await killRunner(request, running.runner)

    // Two crash paths: the container's exit fences the turn (then a 60 s grace), or the runner's own `failed` event ends
    // it unfenced through `terminal` and `endTurn` (no grace). Either way it must be `ended`; a fenced one also waits out its grace.
    await expect.poll(async () => (await probe(request, work.turnId)).state, { timeout: 150_000 }).toBe('ended')
    const ended = await probe(request, work.turnId)
    console.log('W0-B ended after kill', JSON.stringify({ outcome: ended.outcome, failure: ended.failure, fenced: ended.fenced,
      graceOver: ended.graceOver, openTokens: ended.openTokens, session: ended.session, sawCheckpoint: ended.sawCheckpoint }))
    if (ended.fenced === 1) await expect.poll(async () => (await probe(request, work.turnId)).graceOver, { timeout: 90_000 }).toBe(1)
    const crashed = await probe(request, work.turnId)
    expect(crashed).toMatchObject({ session: 'damaged', sessionId: first.sessionId, failure: 'session_crashed',
      checkpointEntries: first.checkpointEntries, checkpointUuidMatches: true, openTokens: 0, sawCheckpoint: 0 })
    const afterCrashFiles = (await filesOf(request, chatId)).map(f => f.path)
    console.log('W0-B after kill', JSON.stringify({ checkpoint: first.checkpointEntries, store: crashed.entries, files: afterCrashFiles }))
    const recovered = await probe(request, work.turnId, true)
    expect(recovered).toMatchObject({ session: 'resumable', sessionId: first.sessionId, checkpointEntries: first.checkpointEntries, entries: crashed.entries })

    const resume = await send(request, member, chatId, 'scenario:long-job-resume [w0-b-spike] Check which files survived and write the result.')
    turns.push(resume.turnId)
    await expect.poll(async () => (await probe(request, resume.turnId)).state, { timeout: 180_000 }).toBe('ended')
    const final = await probe(request, resume.turnId)
    expect(final).toMatchObject({ session: 'resumable', sessionId: first.sessionId, outcome: 'done', sawCheckpoint: 1, mirrorError: 0, checkpointUuidMatches: true })
    expect(final.checkpointEntries).toBeGreaterThan(first.checkpointEntries)
    expect(final.checkpointEntries).toBe(final.entries)
    const answer = textOf(await answerOf(request, member, chatId, resume.turnId))
    console.log('W0-B resumed request', JSON.stringify(answer.split('\n').find(l => l.startsWith('history ')) ?? 'no history line'))
    expect(answer).toContain(LONG_JOB_DONE)
    // A real Messages API refuses a tool_use with no tool_result right after it, so variant A needs none unpaired.
    expect(answer).toContain('unpaired=none')
    const files = await filesOf(request, chatId)
    const result = files.find(f => f.path === 'outputs/job-result.txt')
    expect(result, 'the resumed turn saved a result file').toBeDefined()
    const r = await call(request, member, 'GET', `/api/files/${result!.fileId}`)
    expect(r.status, r.text).toBe(200)
    console.log('W0-B after resume', JSON.stringify({ checkpoint: final.checkpointEntries, store: final.entries, files: files.map(f => f.path), result: r.text }))
    expect(r.text).toBe(afterCrashFiles.includes('outputs/job-tail.txt') ? 'checkpoint\npartial\n' : 'checkpoint\ntail-missing\n')
  } finally {
    tab.close()
    for (const turnId of turns) await call(request, member, 'POST', `/api/turns/${turnId}/stop`, { json: {} })
  }
})
