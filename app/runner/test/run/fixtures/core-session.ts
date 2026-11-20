// A session process that runs the real session core (src/session/core.ts) under the root, with a fake query and an
// in-process store and files route (support/fake-egress.ts), so the root's `released` reflects the core's real exit
// paths. The run's prompt picks the case (P3 R3, #137 review round 1):
//   stop-before-load       a resume whose query waits (the SDK hasn't loaded the transcript yet) until stopped
//   interrupt-before-load  the same, ended by an interrupt (interrupt() refused, so the abort signal fires)
//   error-before-load      a resume whose query throws before the SDK's first store call
//   load-then-stop         a resume whose query loads the main transcript (it matches expect), then waits for a stop
//   restore-stop           the chat has a file whose download never answers: the restore runs until stopped
import { writeFileSync } from 'node:fs'
import { register } from 'node:module'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from '../../../src/session/core.ts'

// The core and the shared protocol import zod. In a child process Node resolves it from the importing file's folder up,
// and app/shared/ has no node_modules of its own when only the runner's packages are installed (CI): send it to the
// runner's copy, as the build and vitest do. Registered before the modules that need it are imported (below).
const zod = new URL('../../../node_modules/zod/index.js', import.meta.url).href
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, next) { return next(s === 'zod' ? ${JSON.stringify(zod)} : s, c) }`)}`)
const { openRootChannel } = await import('../../../src/session/channel.ts')
const { runSession } = await import('../../../src/session/core.ts')
const { PROXY_URL, fakeEgress } = await import('../support/fake-egress.ts')
const { testQueryGuards } = await import('../support/test-seams.ts')

const SID = '7b0f8f0e-2a8c-4f4e-9d36-0c1c7f6b2a11'
const egress = fakeEgress()
// The main transcript the resume expects: three entries, the last uuid u3.
egress.parts.set(JSON.stringify(['k', SID, null]), new Map([['000000000000001-000001', [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'u2' }, { type: 'user', uuid: 'u3' }]]]))
egress.files.set('inputs/a.txt', { body: new TextEncoder().encode('a') })
const real = egress.fetch
egress.fetch = (url, init) => {
  if (!url.endsWith('/files/inputs/a.txt') || mode !== 'restore-stop') return real(url, init)
  // The download never answers: the restore waits until the stop cuts it.
  writeFileSync('waiting', '')
  return new Promise<Response>(() => {})
}

let mode = ''
const query: QueryFn = (params): ReturnType<QueryFn> => {
  const signal = params.options.abortController!.signal
  let wake!: () => void
  const woken = new Promise<void>((r) => (wake = r))
  signal.addEventListener('abort', () => wake(), { once: true })
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    if (mode === 'error-before-load') throw new Error('the CLI exited before it read the store')
    if (mode === 'load-then-stop') await params.options.sessionStore!.load({ projectKey: 'k', sessionId: SID })
    // The test waits for this before it stops or interrupts the run.
    writeFileSync('waiting', '')
    await woken
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
  }
  return Object.assign(gen(), {
    interrupt: async () => {
      if (mode === 'interrupt-before-load') throw new Error('interrupt needs streaming input')
      wake()
    },
  }) as unknown as ReturnType<QueryFn>
}

// The core's own handler, with the case read off the run message on its way in.
const raw = openRootChannel()
const channel: typeof raw = {
  ...raw,
  onMessage: (h) =>
    raw.onMessage((line) => {
      if (line.ok && (line.value as { type?: string }).type === 'run') mode = String((line.value as { config: { prompt: string } }).config.prompt)
      h(line)
    }),
}
await runSession({ channel, query, guards: testQueryGuards, cwd: process.cwd(), env: { PATH: '/bin' }, io: { fetch: egress.fetch, proxyUrl: PROXY_URL }, log: () => {} })
await raw.close()
process.exit(0)
