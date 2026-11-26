// What M1-D's job specs read from the deployment (e2e/api/jobs.spec.ts and the 2-hour job-soak.spec.ts), through the
// routes a person and the release token have, never a tab: the stored job (route 100), the chat's stored messages and
// files, the bell, and the session store (the test-fakes `transcripts` op) for where the job's steps are. A step's tool
// call id carries the run's token (test/scripted-model/scenarios/jobs.ts `stepIdPrefix`), so these find this job's
// steps among every other chat's. Waits are by condition with a timeout, never a fixed sleep.
import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { hook } from './fakes-kit.ts'
import { call } from './kit.ts'
import type { Actor } from './kit.ts'

/** A run token for `run=<token>` (letters and digits). */
export const runToken = (): string => randomUUID().replaceAll('-', '').slice(0, 16)

export interface StoredJob {
  jobId: string; chatId: string; rootTurnId: string; state: 'running' | 'waiting' | 'ended'
  outcome: string | null; startedAt: { ms: number }; endedAt: { ms: number } | null; cost: { minor: number } | null
}

/** Route 100: the chat's newest job, or null. */
export async function storedJob(request: APIRequestContext, who: Actor, chatId: string): Promise<StoredJob | null> {
  const r = await call(request, who, 'GET', `/api/chats/${chatId}/job`)
  expect(r.status, r.text).toBe(200)
  return r.json.job as StoredJob | null
}

/** The job once `ok` holds of it; fails after `timeoutMs` with the job as it was. */
export async function jobWhen(request: APIRequestContext, who: Actor, chatId: string, ok: (j: StoredJob) => boolean, what: string, timeoutMs: number): Promise<StoredJob> {
  let job: StoredJob | null = null
  await expect.poll(async () => {
    job = await storedJob(request, who, chatId)
    return job !== null && ok(job)
  }, { timeout: timeoutMs, intervals: [2_000, 5_000, 10_000], message: `${what} (job: ${JSON.stringify(job)})` }).toBe(true)
  return job!
}

export interface Steps {
  /** Every step call of this run, in the order the session store holds them. */
  calls: string[]
  /** Each call's result: true when it came back as an error (a cut or a lost step), false when it succeeded. */
  results: Map<string, boolean>
}

/** This run's step calls and their results, from every stored transcript part. A part that isn't an entry array fails. */
export async function stepsOf(request: APIRequestContext, prefix: string): Promise<Steps> {
  const r = await hook(request, { op: 'transcripts' })
  expect(r.status, r.text.slice(0, 300)).toBe(200)
  const calls: string[] = []
  const results = new Map<string, boolean>()
  for (const text of r.json.texts as string[]) {
    if (!text.includes(prefix)) continue
    const entries = JSON.parse(text) as unknown
    expect(Array.isArray(entries), 'a stored transcript part is an array of entries').toBe(true)
    for (const e of entries as { message?: { content?: unknown } }[]) {
      const content = e?.message?.content
      if (!Array.isArray(content)) continue
      for (const b of content as { type?: string; id?: string; tool_use_id?: string; is_error?: boolean }[]) {
        if (b?.type === 'tool_use' && typeof b.id === 'string' && b.id.startsWith(prefix) && !calls.includes(b.id)) calls.push(b.id)
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && b.tool_use_id.startsWith(prefix)) results.set(b.tool_use_id, b.is_error === true)
      }
    }
  }
  return { calls, results }
}

/** A step call with no result yet, other than those in `not`: a step running now (the store mirrors as the turn goes). */
export async function runningStep(request: APIRequestContext, prefix: string, not: ReadonlySet<string>, timeoutMs: number): Promise<string> {
  let running: string | undefined
  let seen: Steps = { calls: [], results: new Map() }
  await expect.poll(async () => {
    seen = await stepsOf(request, prefix)
    running = seen.calls.find(id => !seen.results.has(id) && !not.has(id))
    return running !== undefined
  }, { timeout: timeoutMs, intervals: [1_000], message: `a running step of ${prefix} (calls ${seen.calls.length}, results ${seen.results.size})` }).toBe(true)
  return running!
}

export interface StoredMessage { id: string; role: string; turnId: string; pos: number; text?: string; part?: { type: string; text?: string; retryQuestion?: string } }

/** Every stored message of the chat, oldest first (route 24's pages). */
export async function storedMessages(request: APIRequestContext, who: Actor, chatId: string): Promise<StoredMessage[]> {
  const out: StoredMessage[] = []
  let cursor: string | null = null
  for (let page = 0; page < 50; page++) {
    const r = await call(request, who, 'GET', `/api/chats/${chatId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
    expect(r.status, r.text).toBe(200)
    out.push(...(r.json.messages as StoredMessage[]))
    cursor = r.json.nextCursor as string | null
    if (cursor === null) return out.sort((a, b) => a.pos - b.pos)
  }
  throw new Error(`chat ${chatId} has more than 50 pages`)
}

/** The bell's notices of this job (its one notice's id is `job_<jobId>`). */
export async function jobNotices(request: APIRequestContext, who: Actor, jobId: string): Promise<{ id: string }[]> {
  const r = await call(request, who, 'GET', '/api/notifications')
  expect(r.status, r.text).toBe(200)
  return (r.json.items as { id: string }[]).filter(n => n.id === `job_${jobId}`)
}

/** A saved output file of the chat, by its path, as text. */
export async function outputText(request: APIRequestContext, who: Actor, chatId: string, path: string): Promise<string> {
  const l = await call(request, who, 'GET', `/api/chats/${chatId}/files`)
  expect(l.status, l.text).toBe(200)
  const f = (l.json.items as { fileId: string; path: string }[]).find(x => x.path === path)
  expect(f, `${path} in the chat's files`).toBeDefined()
  const got = await call(request, who, 'GET', `/api/files/${f!.fileId}`)
  expect(got.status, got.text).toBe(200)
  return got.text
}

/** The text the person typed never shows as anything but theirs, and nothing else shows as theirs. */
export function onlyThePersonSpeaks(messages: readonly StoredMessage[], personText: string): void {
  const theirs = messages.filter(m => m.role === 'user')
  expect(theirs.map(m => m.text), 'the person\'s messages in the chat').toEqual([personText])
  for (const m of messages) if (m.part?.type === 'error') expect(m.part.retryQuestion, `Try again on ${m.id}`).toBe(personText)
}
