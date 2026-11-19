// Starts a root runner with the test seams on an ephemeral port and talks to it like the Worker does.
import type { AddressInfo } from 'node:net'
import { PROTOCOL_HEADER, PROTOCOL_VERSION, parseRunEventLine, type RunEvent, type RunStart } from '../../../../shared/protocol/index.ts'
import { createRoot, type Root } from '../../../src/server/app.ts'
import type { SpawnSession } from '../../../src/server/session-host.ts'
import { cleanup, testSessionUsers, type TestUsers } from './test-seams.ts'

export type TestRoot = Root & { url: string; logs: Record<string, unknown>[]; users: TestUsers; close(): Promise<void> }

export async function startTestRoot(
  spawnSession: SpawnSession,
  opts: { stopGraceMs?: number; runTimeoutMs?: number; users?: TestUsers } = {},
): Promise<TestRoot> {
  const logs: Record<string, unknown>[] = []
  const users = opts.users ?? testSessionUsers()
  const root = createRoot({
    users,
    spawnSession,
    proxyPort: 9,
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

/** POSTs a run and reads its whole NDJSON stream, every line parsed through the shared schema. */
export async function postRun(root: TestRoot, start: RunStart): Promise<RunEvent[]> {
  return openRun(root, start).done
}

/** POSTs a run and reads its stream as it arrives: `events` fills up live; `hangUp()` drops the connection. */
export function openRun(root: TestRoot, start: RunStart) {
  const ac = new AbortController()
  const events: RunEvent[] = []
  const done = (async () => {
    const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(start), signal: ac.signal })
    if (res.status !== 200) throw new Error(`POST /runs ${res.status}: ${await res.text()}`)
    const decoder = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true })
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        events.push(parseRunEventLine(buf.slice(0, i)))
        buf = buf.slice(i + 1)
      }
    }
    if (buf !== '') throw new Error(`unterminated last line: ${buf.slice(0, 100)}`)
    return events
  })()
  return { events, done, hangUp: () => ac.abort() }
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
