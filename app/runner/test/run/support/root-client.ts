// Starts a root runner with the test seams on an ephemeral port and talks to it like the Worker does.
import type { AddressInfo } from 'node:net'
import { AuditPost, PROTOCOL_HEADER, PROTOCOL_VERSION, PushBatch, RunAdmission, type RunEvent, type RunStart } from '../../../../shared/protocol/index.ts'
import { createRoot, type Root } from '../../../src/server/app.ts'
import type { PushFetch, Timers } from '../../../src/server/pusher.ts'
import type { SpawnSession } from '../../../src/server/session-host.ts'
import { cleanup, testSessionUsers, type TestUsers } from './test-seams.ts'

/**
 * The Worker's egress as the root sees it (`/events/` and `/audit/`), in process: every push is parsed with the shared
 * `PushBatch` schema, events are kept per run deduped by seq (a gap or a reorder is recorded as a violation), and
 * `pushes` records every batch as sent. Tests steer it with `onPush` and `onAudit`.
 */
export type TestEgress = {
  fetch: PushFetch
  /** Each run's events as the Worker holds them (deduped by seq, in seq order). */
  events: Map<string, RunEvent[]>
  /** Every push as sent: run, first and last seq, and whether another batch of that run was still in flight. */
  pushes: { runId: string; from: number; to: number; overlapped: boolean }[]
  audits: AuditPost[]
  /** The run token each push and audit post carried, in order. */
  tokens: { route: 'events' | 'audit'; token: string | undefined }[]
  /** Seq gaps, reorders and schema failures seen. Must stay empty. */
  violations: string[]
  /** null: answer normally (200, ack up to the last seq held, `stop: stopRuns.has(runId)`). */
  onPush: (batch: PushBatch) => Response | null | Promise<Response | null>
  onAudit: (post: AuditPost) => Response | null | Promise<Response | null>
  stopRuns: Set<string>
  /** Resolves with a run's events once its `released` is held. */
  released(runId: string): Promise<RunEvent[]>
}

export function testEgress(): TestEgress {
  const waiters = new Map<string, (() => void)[]>()
  const inFlight = new Set<string>()
  const eg: TestEgress = {
    events: new Map(),
    pushes: [],
    audits: [],
    tokens: [],
    violations: [],
    onPush: () => null,
    onAudit: () => null,
    stopRuns: new Set(),
    async fetch(url, init) {
      const path = new URL(url).pathname
      if (path === '/audit/' || path === '/events/') eg.tokens.push({ route: path === '/audit/' ? 'audit' : 'events', token: init.headers['x-inhouse-run-token'] })
      if (path === '/audit/') {
        const post = AuditPost.parse(JSON.parse(init.body))
        const custom = await eg.onAudit(post)
        if (custom) return custom
        eg.audits.push(post)
        return new Response(null, { status: 204 })
      }
      if (path !== '/events/') return new Response('no route', { status: 404 })
      const parsed = PushBatch.safeParse(JSON.parse(init.body))
      if (!parsed.success) {
        eg.violations.push(`a batch that does not parse: ${parsed.error.message.slice(0, 200)}`)
        return new Response('bad batch', { status: 400 })
      }
      const batch = parsed.data
      const runId = batch.turnId
      eg.pushes.push({ runId, from: batch.events[0]!.seq, to: batch.events.at(-1)!.seq, overlapped: inFlight.has(runId) })
      inFlight.add(runId)
      try {
        const custom = await eg.onPush(batch)
        if (custom) return custom
        const held = eg.events.get(runId) ?? []
        for (const e of batch.events) {
          const next = held.length
          if (e.seq < next) continue
          if (e.seq > next) {
            eg.violations.push(`${runId}: seq ${e.seq} after ${next - 1}`)
            return new Response('gap', { status: 409 })
          }
          held.push(e)
        }
        eg.events.set(runId, held)
        if (held.at(-1)?.type === 'released') for (const w of waiters.get(runId) ?? []) w()
        return Response.json({ ackSeq: held.length - 1, stop: eg.stopRuns.has(runId) })
      } finally {
        inFlight.delete(runId)
      }
    },
    released(runId) {
      return new Promise((resolve) => {
        const ready = () => resolve(eg.events.get(runId) ?? [])
        if (eg.events.get(runId)?.at(-1)?.type === 'released') return ready()
        waiters.set(runId, [...(waiters.get(runId) ?? []), ready])
      })
    },
  }
  return eg
}

export type TestRoot = Root & { url: string; logs: Record<string, unknown>[]; users: TestUsers; egress: TestEgress; close(): Promise<void> }

export async function startTestRoot(
  spawnSession: SpawnSession,
  opts: { stopGraceMs?: number; runTimeoutMs?: number; users?: TestUsers; egress?: TestEgress; pushLingerMs?: number; pushHeartbeatMs?: number; pushMaxBytes?: number; timers?: Timers } = {},
): Promise<TestRoot> {
  const logs: Record<string, unknown>[] = []
  const users = opts.users ?? testSessionUsers()
  const egress = opts.egress ?? testEgress()
  const root = createRoot({
    users,
    spawnSession,
    proxyPort: 9,
    egressUrl: 'http://egress.internal',
    fetch: egress.fetch,
    pushLingerMs: opts.pushLingerMs,
    timers: opts.timers,
    pushHeartbeatMs: opts.pushHeartbeatMs,
    pushMaxBytes: opts.pushMaxBytes,
    stopGraceMs: opts.stopGraceMs ?? 2000,
    runTimeoutMs: opts.runTimeoutMs ?? 60_000,
    memory: () => ({ totalBytes: null, availableBytes: null, rssBytes: 1, heapUsedBytes: 1 }),
    apiPeerAllowed: async () => true,
    log: (e) => logs.push(e),
  })
  await new Promise<void>((r) => root.server.listen(0, '127.0.0.1', r))
  const { port } = root.server.address() as AddressInfo
  return {
    ...root,
    url: `http://127.0.0.1:${port}`,
    logs,
    users,
    egress,
    async close() {
      await root.stopAll()
      root.server.closeAllConnections()
      await new Promise<void>((r) => root.server.close(() => r()))
      cleanup(users)
    },
  }
}

let n = 0
export function runStart(over: Partial<RunStart> = {}): RunStart {
  n++
  return {
    runId: `run-${n}`,
    chatId: `chat-${n}`,
    sessionId: '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11',
    resume: false,
    prompt: 'echo:m:1',
    model: 'claude-sonnet-5-5',
    sideModel: 'claude-haiku-5-5',
    systemPrompt: '',
    attachments: [],
    expect: null,
    effort: 'medium',
    maxTurns: 8,
    maxBudgetUsd: 1,
    runToken: 'tok_0123456789abcdef0123',
    webFetchDomains: [],
    fileCaps: { maxFileBytes: 1_000_000, maxFilesPerTurn: 10, maxRestoreBytes: 10_000_000, allowedTypes: ['application/pdf'] },
    ...over,
  }
}

export const protocolHeaders = { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) }

/** POSTs a run (202) and waits for its `released`; the run's events as the egress holds them, `released` left out. */
export async function postRun(root: TestRoot, start: RunStart): Promise<RunEvent[]> {
  return openRun(root, start).done
}

/**
 * POSTs a run and follows its events at the egress: `events` is the live list (held so far, `released` and heartbeats
 * included); `done` resolves once `released` is held, with every event before it (heartbeats left out too);
 * `released` with the `released` event itself.
 */
export function openRun(root: TestRoot, start: RunStart) {
  const admitted = (async () => {
    const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(start) })
    const text = await res.text()
    if (res.status !== 202) throw new Error(`POST /runs ${res.status}: ${text}`)
    RunAdmission.parse(JSON.parse(text))
  })()
  const all = admitted.then(() => root.egress.released(start.runId))
  return {
    get events(): RunEvent[] {
      return root.egress.events.get(start.runId) ?? []
    },
    admitted,
    done: all.then((es) => es.filter((e) => e.type !== 'released' && e.type !== 'heartbeat')),
    released: all.then((es) => es.at(-1)!),
  }
}

export async function post(root: TestRoot, path: string): Promise<number> {
  const res = await fetch(`${root.url}${path}`, { method: 'POST', headers: protocolHeaders })
  await res.body?.cancel()
  return res.status
}

/** Polls a condition on the event loop (no fixed sleep): resolves as soon as it holds, fails after 10 s. */
export async function waitFor(cond: () => boolean, what = 'condition') {
  const deadline = Date.now() + 10_000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} not met`)
    await new Promise((r) => setImmediate(r))
  }
}
