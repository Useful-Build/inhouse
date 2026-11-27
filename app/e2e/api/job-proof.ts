// What M1-D's job specs read from the deployment (e2e/api/jobs.spec.ts and the 2-hour job-soak.spec.ts), through the
// routes a person and the release token have, never a tab: the stored job (route 100), the chat's stored messages and
// files, the bell, and the session store (the test-fakes `transcripts` op) for where the job's steps are. A step's tool
// call id carries the run's token (test/scripted-model/scenarios/jobs.ts `stepIdPrefix`), so these find this job's
// steps among every other chat's. Waits are by condition with a timeout, never a fixed sleep.
import { randomUUID } from 'node:crypto'
import { expect } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { hook } from './fakes-kit.ts'
import { actor, call } from './kit.ts'
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
  /** Each call's result text, as the session store holds it. */
  texts: Map<string, string>
}

/** This run's step calls and their results, from every stored transcript part. A part that isn't an entry array fails. */
export async function stepsOf(request: APIRequestContext, prefix: string): Promise<Steps> {
  const r = await hook(request, { op: 'transcripts' })
  expect(r.status, r.text.slice(0, 300)).toBe(200)
  const calls: string[] = []
  const results = new Map<string, boolean>()
  const texts = new Map<string, string>()
  for (const text of r.json.texts as string[]) {
    if (!text.includes(prefix)) continue
    const entries = JSON.parse(text) as unknown
    expect(Array.isArray(entries), 'a stored transcript part is an array of entries').toBe(true)
    for (const e of entries as { message?: { content?: unknown } }[]) {
      const content = e?.message?.content
      if (!Array.isArray(content)) continue
      for (const b of content as { type?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
        if (b?.type === 'tool_use' && typeof b.id === 'string' && b.id.startsWith(prefix) && !calls.includes(b.id)) calls.push(b.id)
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && b.tool_use_id.startsWith(prefix)) {
          results.set(b.tool_use_id, b.is_error === true)
          texts.set(b.tool_use_id, typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''))
        }
      }
    }
  }
  return { calls, results, texts }
}

/** A step call with no result yet, other than those in `not`: a step running now (the store mirrors as the turn goes). */
export async function runningStep(request: APIRequestContext, prefix: string, not: ReadonlySet<string>, timeoutMs: number): Promise<string> {
  let running: string | undefined
  let seen: Steps = { calls: [], results: new Map(), texts: new Map() }
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

/**
 * What a job spec prints when its job didn't start or end in time (M2-G, after #454's sandbox runs timed out with no
 * clue): every frame the tab saw for the run (type, turn, outcome and reason), the chat's stored messages (role, turn,
 * text or part type, an end row's extra), the root turn's trace steps and the stored job. Read-only, best effort: a
 * failed read is printed as such, never thrown over the spec's own failure.
 */
export async function explainJob(request: APIRequestContext, who: Actor, o: { chatId: string; turnId: string; frames: readonly { seq: number; event: Record<string, unknown> }[]; prefix?: string }): Promise<string> {
  const out: string[] = [`chat ${o.chatId}, root turn ${o.turnId}`]
  out.push('frames:', ...o.frames.map(f => {
    const e = f.event
    const pick = ['type', 'turnId', 'outcome', 'reason', 'why', 'code', 'jobId', 'source'].flatMap(k => (e[k] === undefined ? [] : [`${k}=${String(e[k])}`]))
    return `  #${f.seq} ${pick.join(' ')}`
  }))
  const read = async (what: string, f: () => Promise<string[]>) => {
    try { out.push(`${what}:`, ...(await f())) } catch (err) { out.push(`${what}: unreadable (${err instanceof Error ? err.message : String(err)})`) }
  }
  await read('stored messages', async () => (await storedMessages(request, who, o.chatId)).map(m => {
    const x = m as StoredMessage & { text?: string; end?: unknown }
    return `  ${m.pos} ${m.role} ${m.turnId} ${x.part?.type ?? ''} ${(x.text ?? (x.part as { text?: string } | undefined)?.text ?? '').slice(0, 80)} ${x.end === undefined ? '' : JSON.stringify(x.end)}`
  }))
  await read('trace', async () => {
    const r = await call(request, who, 'GET', `/api/traces/${encodeURIComponent(o.turnId)}`)
    if (r.status !== 200) return [`  ${r.status} ${r.text.slice(0, 200)}`]
    const t = r.json as { steps?: { kind: string; label?: string; detail?: string }[]; promptVersions?: unknown }
    return [`  promptVersions ${JSON.stringify(t.promptVersions)}`, ...(t.steps ?? []).map(s => `  ${s.kind} ${s.label ?? ''} ${s.detail ?? ''}`.slice(0, 160))]
  })
  await read('job', async () => [`  ${JSON.stringify(await storedJob(request, who, o.chatId))}`])
  if (o.prefix !== undefined) {
    const prefix = o.prefix
    await read('steps', async () => { const s = await stepsOf(request, prefix); return s.calls.map(c => `  ${c} error=${String(s.results.get(c))} ${(s.texts.get(c) ?? '').slice(0, 80)}`) })
  }
  return out.join('\n')
}

/** The bell's job notices for this chat (`A long job finished` or `stopped`, linked to the chat), whatever their id: a
 *  second notice for the job, under any id, shows as two. */
export async function jobNotices(request: APIRequestContext, who: Actor, chatId: string): Promise<{ id: string; text: string }[]> {
  const r = await call(request, who, 'GET', '/api/notifications')
  expect(r.status, r.text).toBe(200)
  const items = r.json.items as { id: string; text: string; link: { to: string; id?: string } }[]
  // The bell answers its newest 50: a spec's chat is new, so its notices are among them.
  return items.filter(n => n.link.to === 'chat' && n.link.id === chatId && /^A long job (finished|stopped)$/.test(n.text))
}

/** Every runner's container generation (route 67's `runnerGen`, read from each Runner's own storage), by name. */
export async function runnerGens(request: APIRequestContext): Promise<Record<string, number>> {
  const gens: Record<string, number> = {}
  for (let i = 0; i < 64; i++) {
    const runner = `runner-${i}`
    const r = await call(request, actor('release'), 'POST', '/api/ops/alarm', { json: { action: 'runnerGen', runner } })
    if (r.status === 404) {
      expect(r.json, r.text).toEqual({ error: { code: 'not_found', reason: 'runner' } })
      return gens
    }
    expect(r.status, r.text).toBe(200)
    gens[runner] = (r.json as { gen: number }).gen
  }
  throw new Error('route 67 never answered 404 for a runner up to runner-63')
}

/** The SDK's own result for a call whose session died before it was recorded (the spike: claude-agent-sdk's text). A
 *  server cut's interrupt gives a different text, so this tells a lost container from a cut. */
export const LOST_CALL = /session ended before this call's result was recorded/

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
