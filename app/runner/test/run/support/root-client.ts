// Starts a root runner with the test seams on an ephemeral port and talks to it like the Worker does.
import type { AddressInfo } from 'node:net'
import { PROTOCOL_HEADER, PROTOCOL_VERSION, parseRunEventLine, type RunEvent, type RunStart } from '../../../../shared/protocol/index.ts'
import { createRoot, type Root } from '../../../src/server/app.ts'
import type { SpawnSession } from '../../../src/server/session-host.ts'
import { cleanup, testSessionUsers } from './test-seams.ts'

export type TestRoot = Root & { url: string; logs: Record<string, unknown>[]; close(): Promise<void> }

export async function startTestRoot(spawnSession: SpawnSession, opts: { stopGraceMs?: number; runTimeoutMs?: number } = {}): Promise<TestRoot> {
  const logs: Record<string, unknown>[] = []
  const users = testSessionUsers()
  const root = createRoot({
    users,
    spawnSession,
    proxyPort: 9,
    stopGraceMs: opts.stopGraceMs ?? 2000,
    runTimeoutMs: opts.runTimeoutMs ?? 60_000,
    memory: () => ({ totalBytes: null, availableBytes: null, rssBytes: 1, heapUsedBytes: 1 }),
    log: (e) => logs.push(e),
  })
  await new Promise<void>((r) => root.server.listen(0, '127.0.0.1', r))
  const { port } = root.server.address() as AddressInfo
  return {
    ...root,
    url: `http://127.0.0.1:${port}`,
    logs,
    async close() {
      await root.stopAll()
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
  const res = await fetch(`${root.url}/runs`, { method: 'POST', headers: protocolHeaders, body: JSON.stringify(start) })
  if (res.status !== 200) throw new Error(`POST /runs ${res.status}: ${await res.text()}`)
  const text = await res.text()
  return text.split('\n').filter(Boolean).map(parseRunEventLine)
}
