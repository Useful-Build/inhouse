// The Runner object's logic (runner.ts) with the container behind a port (a fake below) and the object's real SQLite.
// Expected values are literal wire fixtures and literal call lists, never read from runner.ts. Ways it can fail,
// written down first:
//  1. a v4 Worker and a v4 runner don't agree on 4; a v4 Worker doesn't fall back to 3 for the previous image; a [2]
//     runner still admits (it must report `protocol`, and send nothing); a v3 runner gets a helper key (its strict
//     schema refuses the start) or loses its brand skills;
//  2. the intercepts go in another order, carry more than `{ runner, containerGen }` (a token, chat or member), or are
//     registered again for a container that's still running; the container starts with Internet on;
//  3. `touch()` doesn't re-arm the inactivity timeout each time, starts a container, or after an object restart doesn't
//     call `monitor()` again;
//  4. two settlements of one generation's monitor report the exit twice;
//  5. an admission with no answer in 15 s is reported as a refusal (it must be `ambiguous`), or the fetch isn't aborted;
//  6. the refusals aren't told apart (503 codes, 409, another answer, a container that never answers /protocol);
//  7. `status` maps the runner's states wrong, or reports `unreachable` for an answer / misses a gone container;
//  9. an exit is reported as a container that came up when it never answered /protocol (a failed start), or as one that
//     never came up when it had (after a refusal, or while its admission was in flight);
//  8. a cold start slower than the boot deadline (over 60 s on the sandbox, 2026-11-21) is a placement error, or a
//     deadline that passed on a still-running container doesn't say it's still booting.
import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import type { RunStart } from '../../../shared/protocol/index.ts'
import { ADMIT_TIMEOUT_MS, BOOT_TIMEOUT_MS, RunnerCore, reasonOf, sqlRunnerState, type ContainerPort, type EgressProps, type RunnerState } from './runner.ts'
import { STARTING_DEADLINE_MS } from '../brand-agent/core.ts'

type Binding = { kind: 'egress' | 'web' | 'deny'; props: EgressProps }
type Route = (path: string, init: RequestInit | undefined) => Response | Promise<Response>

class FakeContainer implements ContainerPort<Binding> {
  running = false
  log: string[] = []
  intercepts: { method: string; addr: string | null; binding: Binding }[] = []
  starts: { enableInternet: boolean; env: Record<string, string> }[] = []
  timeouts: number[] = []
  monitors: { resolve: () => void; reject: (e: unknown) => void }[] = []
  requests: { path: string; init: RequestInit | undefined }[] = []
  route: Route = () => new Response('no route', { status: 500 })

  start(options: { enableInternet: boolean; env: Record<string, string> }) {
    if (this.running) throw new Error('already running')
    this.log.push('start')
    this.starts.push(options)
    this.running = true
  }
  async setInactivityTimeout(ms: number) {
    this.log.push('timeout')
    this.timeouts.push(ms)
  }
  monitor() {
    this.log.push('monitor')
    return new Promise<void>((resolve, reject) => this.monitors.push({ resolve, reject }))
  }
  async interceptOutboundHttp(addr: string, binding: Binding) {
    this.log.push('intercept')
    this.intercepts.push({ method: 'http', addr, binding })
  }
  async interceptOutboundHttps(addr: string, binding: Binding) {
    this.log.push('intercept')
    this.intercepts.push({ method: 'https', addr, binding })
  }
  async interceptAllOutboundHttp(binding: Binding) {
    this.log.push('intercept')
    this.intercepts.push({ method: 'all-http', addr: null, binding })
  }
  destroys = 0
  async destroy() {
    this.log.push('destroy')
    this.destroys++
    this.exit(0)
  }
  getTcpPort(port: number) {
    if (port !== 8080) throw new Error(`unexpected port ${port}`)
    return {
      fetch: async (input: string, init?: RequestInit) => {
        const path = new URL(input).pathname
        this.requests.push({ path, init })
        return this.route(path, init)
      },
    }
  }
  /** The container's main process ends: every pending monitor settles (a nonzero code rejects). */
  exit(code: number) {
    this.running = false
    for (const m of this.monitors.splice(0)) {
      if (code === 0) m.resolve()
      else m.reject(Object.assign(new Error('exited'), { exitCode: code }))
    }
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A runner as it answers `/protocol` and `/health` for `accepted` (wire fixtures written out, not built from the schemas). */
function fakeRunner(accepted: number[], runs: Route = () => json(202, { accepted: true })): Route {
  return (path, init) => {
    if (path === '/protocol') return json(200, { version: accepted[0], accepted })
    if (path === '/health') return json(200, { ok: true, protocol: accepted[0], live: 0, memory: { totalBytes: null, availableBytes: null, rssBytes: 1, heapUsedBytes: 1 } })
    return runs(path, init)
  }
}

const RS: RunStart = {
  runId: 't_turnAAAAAAAAAAAAAAAAAAAA',
  chatId: 'chat-1',
  sessionId: '0b9a3f5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  resume: false,
  prompt: 'hello',
  model: 'claude-sonnet-5-5',
  sideModel: 'claude-haiku-5-5',
  systemPrompt: '',
  attachments: [],
  expect: null,
  effort: 'medium',
  maxTurns: 25,
  maxBudgetUsd: 10,
  runToken: 'tok_not_a_real_token_0123456789',
  webFetchDomains: [],
  fileCaps: { maxFileBytes: 1, maxFilesPerTurn: 1, maxRestoreBytes: 1, allowedTypes: ['text/plain'] },
}

let objects = 0
/** Runs a test inside a fresh Runner object, on its real SQLite (storage and fetches belong to that object). */
const t = <A extends unknown[]>(fn: (state: RunnerState, ...args: A) => Promise<void>) => (...args: A) =>
  runInDurableObject(env.RUNNER.getByName(`runner-test-${++objects}`), (_i, s) => fn(sqlRunnerState(s.storage.sql), ...args))

interface Made {
  core: RunnerCore<Binding>
  /** [runner, gen, how many starts the container had seen when the exit was reported] */
  exits: [string, number, number][]
  /** [gen, cameUp] as each exit was reported: whether that generation had answered /protocol */
  ups: [number, boolean][]
  aborts: AbortController[]
  logs: Record<string, unknown>[]
}
function make(container: FakeContainer, state: RunnerState, accepted?: readonly number[], name = 'runner-0'): Made {
  const exits: [string, number, number][] = []
  const ups: [number, boolean][] = []
  const aborts: AbortController[] = []
  const logs: Record<string, unknown>[] = []
  const core = new RunnerCore<Binding>({
    name,
    container,
    state,
    bindings: {
      egress: props => ({ kind: 'egress', props }),
      web: props => ({ kind: 'web', props }),
      deny: props => ({ kind: 'deny', props }),
    },
    exited: async (runner, gen, cameUp) => { exits.push([runner, gen, container.starts.length]); ups.push([gen, cameUp]) },
    accepted,
    timeout: () => {
      const c = new AbortController()
      aborts.push(c)
      return c.signal
    },
    wait: async () => {},
    log: e => void logs.push(e),
  })
  return { core, exits, ups, aborts, logs }
}

const headerOf = (init: RequestInit | undefined) => new Headers(init?.headers).get('x-inhouse-protocol')
/** Lets the monitor's settlement handlers run. */
const settle = () => new Promise(r => setTimeout(r, 0))

describe('protocol versions (literal wire fixtures)', () => {
  it('a v4 Worker against a runner answering {version: 4, accepted: [4, 3]} admits on 4', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual({ accepted: true, gen: 1, protocol: 4 })
    const post = c.requests.find(r => r.path === '/runs')!
    expect(headerOf(post.init)).toBe('4')
    expect(post.init?.method).toBe('POST')
  }))

  it('a v4 Worker against the previous runner image ([3, 2]) runs on 3', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([3, 2])
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual({ accepted: true, gen: 1, protocol: 3 })
    expect(headerOf(c.requests.find(r => r.path === '/runs')!.init)).toBe('3')
  }))

  it('a v4 Worker against a [2] runner reports `protocol` and sends no run (v2 is no longer spoken)', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([2])
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual({ protocol: 'none', gen: 1 })
    expect(c.requests.map(r => r.path)).toEqual(['/protocol'])
  }))

  it('an injected [5, 4] Worker against a [4, 3] runner runs on 4', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    expect(await make(c, state, [5, 4]).core.admit(RS)).toEqual({ accepted: true, gen: 1, protocol: 4 })
    expect(headerOf(c.requests.find(r => r.path === '/runs')!.init)).toBe('4')
  }))

  it('an injected [5] Worker against a [4, 3] runner reports `protocol` and sends no run', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    expect(await make(c, state, [5]).core.admit(RS)).toEqual({ protocol: 'none', gen: 1 })
    expect(c.requests.map(r => r.path)).toEqual(['/protocol'])
  }))

  // v3 (P6a brand skills) and v4 (Stage 1 helpers): a start carries only the keys the runner's version knows. Brand
  // skills reach a v3 runner; the helper keys (agents, subagentModel, actions) reach only a v4 runner, all three or none.
  const skills = [{ name: 'weekly-report', description: 'Writes the weekly report.', body: 'Read the orders.' }]
  const agents = { researcher: { description: 'Finds facts.', prompt: 'Research.' }, analyst: { description: 'Works numbers.', prompt: 'Analyse.' } }
  const full: RunStart = { ...RS, brandSkills: skills, agents, subagentModel: 'claude-sonnet-5-5', actions: true }
  const sentBody = (c: FakeContainer) => JSON.parse(String(c.requests.find(r => r.path === '/runs')!.init?.body)) as Record<string, unknown>

  it('a [4, 3] runner gets the helper keys and brand skills as sent', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    expect(await make(c, state).core.admit(full)).toEqual({ accepted: true, gen: 1, protocol: 4 })
    const sent = sentBody(c)
    expect(sent.agents).toEqual(agents)
    expect(sent.subagentModel).toBe('claude-sonnet-5-5')
    expect(sent.actions).toBe(true)
    expect(sent.brandSkills).toEqual(skills)
  }))

  it('a [3, 2] runner gets the start without agents, subagentModel and actions (brand skills kept), and admits it', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([3, 2])
    const { core, logs } = make(c, state)
    expect(await core.admit(full)).toEqual({ accepted: true, gen: 1, protocol: 3 })
    const sent = sentBody(c)
    expect(Object.keys(sent).filter(k => ['agents', 'subagentModel', 'actions'].includes(k))).toEqual([])
    expect(sent.brandSkills).toEqual(skills)
    expect(sent.runId).toBe(RS.runId)
    expect(logs.filter(l => l.event === 'start_keys_dropped')).toEqual([{ event: 'start_keys_dropped', turnId: RS.runId, protocol: 3, keys: ['agents', 'subagentModel', 'actions'] }])
  }))

  it('`actions: false` alone is left out for a v3 runner too (strict schema), with nothing logged as dropped but it', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([3, 2])
    const { core, logs } = make(c, state)
    expect(await core.admit({ ...RS, actions: false })).toEqual({ accepted: true, gen: 1, protocol: 3 })
    expect(sentBody(c)).not.toHaveProperty('actions')
    expect(logs.filter(l => l.event === 'start_keys_dropped').map(l => l.keys)).toEqual([['actions']])
  }))

  it('a start without the helper keys goes to a v3 runner unchanged, and nothing is logged as dropped', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([3, 2])
    const { core, logs } = make(c, state)
    expect(await core.admit(RS)).toEqual({ accepted: true, gen: 1, protocol: 3 })
    expect(sentBody(c)).toEqual(JSON.parse(JSON.stringify(RS)))
    expect(logs.filter(l => l.event === 'start_keys_dropped')).toEqual([])
  }))

  it('a 426 from the runner is `protocol`', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], () => json(426, { error: 'unsupported protocol version', version: 4 }))
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual({ protocol: 'none', gen: 1 })
  }))
})

describe('container start', () => {
  it('registers the intercepts in order with props { runner, containerGen } only, then starts with no Internet', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const { core } = make(c, state, undefined, 'runner-3')
    await core.admit(RS)
    expect(c.log).toEqual(['intercept', 'intercept', 'intercept', 'start', 'timeout', 'monitor'])
    expect(c.intercepts.map(i => [i.method, i.addr, i.binding.kind])).toEqual([
      ['http', 'egress.internal', 'egress'],
      ['https', '*', 'web'],
      ['all-http', null, 'deny'],
    ])
    for (const i of c.intercepts) {
      expect(Object.keys(i.binding.props).sort()).toEqual(['containerGen', 'runner'])
      expect(i.binding.props).toEqual({ runner: 'runner-3', containerGen: 1 })
    }
    expect(c.starts).toEqual([{ enableInternet: false, env: { EGRESS_URL: 'http://egress.internal', PORT: '8080', PROXY_PORT: '8081' } }])
    expect(c.timeouts).toEqual([600_000])
  }))

  it('a second admission on the running container starts nothing and registers nothing', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const { core } = make(c, state)
    await core.admit(RS)
    await core.admit({ ...RS, runId: 't_turnBBBBBBBBBBBBBBBBBBBB' })
    expect(c.log).toEqual(['intercept', 'intercept', 'intercept', 'start', 'timeout', 'monitor'])
    expect(c.requests.filter(r => r.path === '/protocol')).toHaveLength(1)
  }))

  it('a new container after an exit is a new generation: intercepts again with the new gen, protocol renegotiated', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const m = make(c, state)
    await m.core.admit(RS)
    c.exit(137)
    await settle()
    expect(await m.core.admit(RS)).toEqual({ accepted: true, gen: 2, protocol: 4 })
    expect(c.intercepts.slice(3).map(i => i.binding.props.containerGen)).toEqual([2, 2, 2])
    expect(c.requests.filter(r => r.path === '/protocol')).toHaveLength(2)
    expect(m.exits).toEqual([['runner-0', 1, 1]])
  }))

  it('a container that stops before answering /protocol is a placement error', t(async state => {
    const c = new FakeContainer()
    c.route = path => {
      if (path === '/protocol') c.running = false
      throw new TypeError('connection refused')
    }
    const { core } = make(c, state)
    const r = await core.admit(RS)
    expect('placementError' in r).toBe(true)
    expect(c.requests.map(x => x.path)).not.toContain('/runs')
  }))
})

describe('boot deadline', () => {
  it('one deadline bounds the whole start: when it passes, no more /protocol tries and a placement error', t(async state => {
    const c = new FakeContainer()
    // /protocol never answers: each call hangs until its signal aborts.
    c.route = (_p, init) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason)))
    const m = make(c, state)
    const pending = m.core.admit(RS)
    await settle()
    // The first signal handed out is the boot deadline; the second the first try's own 10 s.
    m.aborts[0].abort(new DOMException('timed out', 'TimeoutError'))
    const r = await pending
    expect(r).toEqual({ placementError: expect.stringContaining('within 150000 ms'), booting: true })
    expect(c.requests.map(x => x.path)).toEqual(['/protocol'])
  }))
})

describe('a slow cold start (failure 8)', () => {
  it('a whole admission (the boot deadline, then the 15 s admit) fits in the starting turn\'s deadline', () => {
    expect(BOOT_TIMEOUT_MS + ADMIT_TIMEOUT_MS).toBeLessThan(STARTING_DEADLINE_MS)
  })

  it('/protocol first answering 90 s into the start: admitted on that container, no second start', t(async state => {
    const c = new FakeContainer()
    // A clock the deps' timeouts and waits share: each signal aborts once the clock passes its own deadline.
    let clock = 0
    const timers: { at: number; c: AbortController }[] = []
    const routes = fakeRunner([4, 3])
    c.route = (path, init) => {
      if (path === '/protocol' && clock < 90_000) throw new TypeError('connection refused')
      return routes(path, init)
    }
    const core = new RunnerCore<Binding>({
      name: 'runner-0', container: c, state,
      bindings: { egress: props => ({ kind: 'egress', props }), web: props => ({ kind: 'web', props }), deny: props => ({ kind: 'deny', props }) },
      exited: async () => {},
      timeout: ms => { const a = new AbortController(); timers.push({ at: clock + ms, c: a }); return a.signal },
      wait: async ms => {
        clock += ms
        for (const x of timers) if (x.at <= clock && !x.c.signal.aborted) x.c.abort(new DOMException('timed out', 'TimeoutError'))
      },
      log: () => {},
    })
    expect(await core.admit(RS)).toEqual({ accepted: true, gen: 1, protocol: 4 })
    expect(clock).toBeGreaterThanOrEqual(90_000)
    expect(c.starts.length).toBe(1)
  }))

  it('a deadline that passes on a stopped container says it is not booting', t(async state => {
    const c = new FakeContainer()
    c.route = path => {
      if (path === '/protocol') c.running = false
      throw new TypeError('connection refused')
    }
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual({ placementError: 'the container stopped before it answered /protocol', booting: false })
  }))
})

describe('an exit says whether its container came up (failure 9)', () => {
  it('a container that stops before answering /protocol: reported as never up', t(async state => {
    const c = new FakeContainer()
    c.route = () => { c.exit(1); throw new TypeError('connection refused') }
    const m = make(c, state)
    expect(await m.core.admit(RS)).toEqual({ placementError: 'the container stopped before it answered /protocol', booting: false })
    await settle()
    expect(m.ups).toEqual([[1, false]])
  }))

  // The platform's monitor() rejects with a plain Error whose message carries the code (cloudflare/containers'
  // getExitCodeFromError reads the same two shapes): https://github.com/cloudflare/containers/blob/main/src/lib/container.ts
  it.each([
    ['an unexpected exit', () => new Error('Container exited with unexpected exit code: 3'), 'exit code 3'],
    ['a runtime signal', () => new Error('Runtime signalled the container to exit: 15'), 'signalled 15'],
    ['any other platform text', () => new Error('CANARY-chat-text broke: 9'), 'Error'],
    ['an exit shape whose code is not digits', () => new Error('Container exited with unexpected exit code: CANARY-chat-text'), 'Error'],
  ])("container_exited on %s logs the platform's code only (P8a P-auth)", (_what, error, how) => t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const m = make(c, state)
    expect(await m.core.admit(RS)).toEqual({ accepted: true, gen: 1, protocol: 4 })
    c.monitors.splice(0).forEach(x => x.reject(error()))
    await settle()
    expect(m.logs.filter(l => l.event === 'container_exited')).toEqual([{ event: 'container_exited', gen: 1, cameUp: true, how }])
    expect(JSON.stringify(m.logs)).not.toContain('CANARY')
  })())

  it('container_exited on a clean exit logs exit 0', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const m = make(c, state)
    expect(await m.core.admit(RS)).toEqual({ accepted: true, gen: 1, protocol: 4 })
    c.monitors.splice(0).forEach(x => x.resolve())
    await settle()
    expect(m.logs.filter(l => l.event === 'container_exited')).toEqual([{ event: 'container_exited', gen: 1, cameUp: true, how: 'exit 0' }])
  }))

  it("reasonOf passes our own literal reasons through unchanged, and nothing else's text", () => {
    expect(reasonOf('exited while the object was away')).toBe('exited while the object was away')
    expect(reasonOf('replaced at warm-up')).toBe('replaced at warm-up')
    expect(reasonOf(new TypeError('CANARY-chat-text'))).toBe('TypeError')
  })

  it("a warm-up whose container stops keeps our own reason as the detail, not the platform's", t(async state => {
    const c = new FakeContainer()
    c.route = () => { c.exit(1); throw new TypeError('connection refused: CANARY-chat-text') }
    const { core } = make(c, state)
    expect(await core.warm(null)).toEqual({ ok: false, why: 'start', detail: 'the container stopped before it answered /protocol' })
  }))

  it('a container that answered, refused the run (typed 503) and then died: reported as up', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], () => json(503, { error: 'the runner is stopping' }))
    const m = make(c, state)
    expect(await m.core.admit(RS)).toEqual({ unavailable: 'the runner is stopping', gen: 1 })
    c.exit(1)
    await settle()
    expect(m.ups).toEqual([[1, true]])
  }))

  it('a container that answered /protocol with no shared version (stored null) and then exited: reported as up', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([2])
    const m = make(c, state)
    expect(await m.core.admit(RS)).toEqual({ protocol: 'none', gen: 1 })
    expect(state.protocol(1)).toBeNull()
    c.exit(1)
    await settle()
    expect(m.ups).toEqual([[1, true]])
  }))

  it('a container that dies while its admission is in flight (after /protocol): reported as up', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], (_p, init) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason))))
    const m = make(c, state)
    const pending = m.core.admit(RS)
    await settle()
    expect(c.requests.map(x => x.path)).toEqual(['/protocol', '/runs'])
    c.exit(1)
    await settle()
    expect(m.ups).toEqual([[1, true]])
    m.aborts.at(-1)!.abort(new DOMException('timed out', 'TimeoutError'))
    expect(await pending).toEqual({ ambiguous: true, gen: 1 })
  }))
})

describe('liveness', () => {
  it('a touch every 30 s for over 15 minutes re-arms the timeout each time and starts nothing', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const { core } = make(c, state)
    await core.admit(RS)
    // 16 minutes of pushes, one every 30 s (the core reads no clock: each push is one touch).
    for (let t = 30_000; t <= 16 * 60_000; t += 30_000) await core.touch()
    expect(c.timeouts).toEqual(Array(33).fill(600_000))
    expect(c.starts).toHaveLength(1)
    expect(c.log.filter(x => x === 'monitor')).toHaveLength(1)
  }))

  it('a touch with no container does nothing', t(async state => {
    const c = new FakeContainer()
    const { core } = make(c, state)
    await core.touch()
    expect(c.log).toEqual([])
  }))

  it('an object restart with the container running: monitor() called again on touch, intercepts not duplicated', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
        await make(c, state).core.admit(RS)
    // The object restarts: a new core over the same storage, the container still running.
    const after = make(c, state)
    await after.core.touch()
    expect(c.log).toEqual(['intercept', 'intercept', 'intercept', 'start', 'timeout', 'monitor', 'timeout', 'monitor'])
    expect(c.intercepts).toHaveLength(3)
    // The negotiated version survived the restart: no new /protocol before the next run.
    expect(await after.core.admit({ ...RS, runId: 't_turnCCCCCCCCCCCCCCCCCCCC' })).toEqual({ accepted: true, gen: 1, protocol: 4 })
    expect(c.requests.filter(r => r.path === '/protocol')).toHaveLength(1)
  }))

  it('an object restart: the first admission (no touch before it) re-arms the timeout and the monitor', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    await make(c, state).core.admit(RS)
    const after = make(c, state)
    expect(await after.core.admit({ ...RS, runId: 't_turnDDDDDDDDDDDDDDDDDDDD' })).toEqual({ accepted: true, gen: 1, protocol: 4 })
    expect(c.timeouts).toEqual([600_000, 600_000])
    expect(c.log.filter(x => x === 'monitor')).toHaveLength(2)
    expect(c.starts).toHaveLength(1)
  }))

  it('a container that exited while the object was away is reported before the next one starts', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    await make(c, state).core.admit(RS)
    // The object is evicted; its monitor is gone with it, and the container then stops unseen.
    c.monitors.splice(0)
    c.running = false
    const after = make(c, state)
    expect(await after.core.admit(RS)).toEqual({ accepted: true, gen: 2, protocol: 4 })
    // Reported while only the first container had started: before the new one.
    expect(after.exits).toEqual([['runner-0', 1, 1]])
    expect(c.starts).toHaveLength(2)
  }))

  it('two settlements of one generation report the exit once', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
        const first = make(c, state)
    await first.core.admit(RS)
    const second = make(c, state)
    await second.core.touch()
    expect(c.monitors).toHaveLength(2)
    c.exit(1)
    await settle()
    expect([...first.exits, ...second.exits]).toEqual([['runner-0', 1, 1]])
  }))
})

describe('admission answers', () => {
  it('no answer in 15 s: the fetch is aborted and the answer is ambiguous, never a refusal', t(async state => {
    const c = new FakeContainer()
    let seen: AbortSignal | undefined
    c.route = fakeRunner([4, 3], (_p, init) => new Promise<Response>((_res, rej) => {
      seen = init!.signal!
      seen.addEventListener('abort', () => rej(seen!.reason))
    }))
    const m = make(c, state)
    const pending = m.core.admit(RS)
    await settle()
    expect(seen).toBeDefined()
    // The admission's own timeout fires (the last signal handed out is the /runs one).
    m.aborts.at(-1)!.abort(new DOMException('timed out', 'TimeoutError'))
    expect(await pending).toEqual({ ambiguous: true, gen: 1 })
    expect(seen!.aborted).toBe(true)
  }))

  it.each([
    [503, { error: 'session_pool_exhausted' }, { refused: 'session_pool_exhausted', gen: 1 }],
    [503, { error: 'session_folder_parked' }, { refused: 'session_folder_parked', gen: 1 }],
    [409, { error: 'chat_live' }, { refused: 'chat_live', gen: 1 }],
    [409, { error: 'run_live' }, { refused: 'run_live', gen: 1 }],
  ])('%i %j is a definite refusal', t(async (state, status: number, body: unknown, want: unknown) => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], () => json(status, body))
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual(want)
  }))

  it.each([
    [400, { error: 'bad body' }, { rejected: 400, gen: 1 }],
    [413, { error: 'body too large' }, { rejected: 413, gen: 1 }],
    [503, { error: 'the runner is stopping' }, { unavailable: 'the runner is stopping', gen: 1 }],
    [500, { error: 'could not set up the session user' }, { unavailable: 'could not set up the session user', gen: 1 }],
  ])('a typed %i %j is definite: %j', t(async (state, status: number, body: unknown, want: unknown) => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], () => json(status, body))
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual(want)
  }))

  it.each([
    [500, 'oops'],
    [502, '<html>bad gateway</html>'],
    [504, ''],
    [503, 'Service Unavailable'],
    [200, JSON.stringify({ accepted: true })],
    [404, 'not found'],
  ])('%i %s is untyped: ambiguous (the runner may have admitted)', t(async (state, status: number, body: string) => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], () => new Response(body, { status }))
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual({ ambiguous: true, gen: 1 })
  }))

  it('a bare 409 (no readable body) is the chat being live: chat_live', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], () => new Response('conflict', { status: 409 }))
    const { core } = make(c, state)
    expect(await core.admit(RS)).toEqual({ refused: 'chat_live', gen: 1 })
  }))
})

describe('status', () => {
  it.each([
    [{ state: 'admitted', lastSeq: null, ackedSeq: null }, 'live'],
    [{ state: 'running', lastSeq: 4, ackedSeq: 3 }, 'live'],
    [{ state: 'ending', lastSeq: 9, ackedSeq: 9 }, 'live'],
    [{ state: 'released', lastSeq: 10, ackedSeq: 10 }, 'ended'],
    [{ state: 'unknown', lastSeq: null, ackedSeq: null }, 'unknown'],
  ])('%j → %s', t(async (state, body: unknown, want: string) => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], path => (path === '/runs/t_1' ? json(200, body) : json(202, { accepted: true })))
    const { core } = make(c, state)
    await core.admit(RS)
    expect(await core.status('t_1')).toEqual({ state: want, containerGone: false })
  }))

  it('a call that fails because the container just stopped is unreachable and gone', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], path => {
      if (path === '/runs/t_1') {
        c.running = false
        throw new TypeError('connection reset')
      }
      return json(202, { accepted: true })
    })
    const { core } = make(c, state)
    await core.admit(RS)
    expect(await core.status('t_1')).toEqual({ state: 'unreachable', containerGone: true })
  }))

  it('a failed call is unreachable with the container still there; no container is unreachable and gone', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3], path => {
      if (path === '/runs/t_1') throw new TypeError('network')
      return json(202, { accepted: true })
    })
    const { core } = make(c, state)
    await core.admit(RS)
    expect(await core.status('t_1')).toEqual({ state: 'unreachable', containerGone: false })
    c.exit(137)
    expect(await core.status('t_1')).toEqual({ state: 'unreachable', containerGone: true })
    expect(c.starts).toHaveLength(1)
  }))
})

describe('warm', () => {
  it('needs /protocol afresh and /health ok', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const { core } = make(c, state)
    expect(await core.warm()).toEqual({ ok: true, gen: 1, protocol: 4 })
    expect(c.requests.map(r => r.path)).toEqual(['/protocol', '/protocol', '/health'])
  }))

  it('a container no newer than the drain\'s, running nothing: replaced by a new generation, its exit reported once', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const m = make(c, state)
    await m.core.admit(RS)
    expect(await m.core.warm(1)).toEqual({ ok: true, gen: 2, protocol: 4 })
    expect(c.destroys).toBe(1)
    expect(c.starts).toHaveLength(2)
    await settle()
    expect(m.exits).toEqual([['runner-0', 1, 1]])
  }))

  it('a container no newer than the drain\'s still running turns: busy, nothing destroyed', t(async state => {
    const c = new FakeContainer()
    const base = fakeRunner([4, 3])
    c.route = (path, init) => (path === '/health' ? json(200, { ok: true, protocol: 4, live: 1, memory: { totalBytes: null, availableBytes: null, rssBytes: 1, heapUsedBytes: 1 } }) : base(path, init))
    const m = make(c, state)
    await m.core.admit(RS)
    expect(await m.core.warm(1)).toMatchObject({ ok: false, why: 'busy' })
    expect(c.destroys).toBe(0)
  }))

  it('a container newer than the drain\'s is kept', t(async state => {
    const c = new FakeContainer()
    c.route = fakeRunner([4, 3])
    const m = make(c, state)
    await m.core.admit(RS)
    expect(await m.core.warm(0)).toEqual({ ok: true, gen: 1, protocol: 4 })
    expect(c.destroys).toBe(0)
  }))

  it('a failing /health refuses', t(async state => {
    const c = new FakeContainer()
    const base = fakeRunner([4, 3])
    c.route = (path, init) => (path === '/health' ? json(503, { error: 'not ready' }) : base(path, init))
    const { core } = make(c, state)
    expect(await core.warm()).toMatchObject({ ok: false, why: 'health' })
  }))
})
