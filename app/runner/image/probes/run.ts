// The guards, proven in the container (P3 R2, PR B). Runs as root inside the built image, never in the product: CI's
// runner job bundles it (image/probes/build.sh) and mounts the bundle read-only at /opt/runner/probes:
//
//   docker run --rm <flags in ci.yml> -v <bundle>:/opt/runner/probes:ro -e PROBE_GW_PORT=<port> inhouse-runner:ci \
//     node /opt/runner/probes/run.mjs
//
// It starts the real root runner (/opt/runner/dist/main.mjs) with a fake egress in front of the scripted model, so the
// agent's Bash, Read, Glob and Grep run exactly as in production: the session as its own pool user, the real guards,
// the real sandbox, the CLI through the process-limit wrapper. Probes that don't need the agent run as a pool user (or
// as root) directly, and the host's own code (src/guards/host.ts) is called for the wipes.
//
// A probe passes only if its guard held and a control shows the observable appears without that guard: the same
// thing run with the guard off, in this script only (as root, as the owner's uid outside the sandbox, or a direct
// session with a test-only variant that takes out just that guard). A probe whose detector can't see the leak in its
// control fails. Where no control can be made, the result is printed as `FACT` (what the kernel and the engine do) or
// as `FACT <name>: UNPROVEN: <why>`, never as a pass; each probe as `PROBE PASS|FAIL`. Exit code 1 if any probe failed.
//
// The host's HTTP server (PROBE_GW_PORT, on the Docker bridge gateway) serves probe.txt with GW_OK: a private address
// outside the container that the sandbox's allowlist can name.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { PROTOCOL_HEADER, PROTOCOL_VERSION, type RunEvent, type RunStart } from '../../../shared/protocol/index.ts'
import { SHARED_WRITABLE, createSessionHost, parseStatus, readProcs } from '../../src/guards/host.ts'
import { ALLOWED_SKILLS, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF, INHOUSE_MCP_SERVER, PLUGIN_NAME } from '../../src/guards/lists.ts'
import { SESSION_PROCESS_LIMIT, USERS_ROOT, sessionPaths, userPaths } from '../../src/guards/paths.ts'
import { readPool, type PoolUser } from '../../src/guards/users.ts'
import { productionHostDeps } from '../../src/server/production.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { DirectInput, DirectVariant } from './direct.ts'
import {
  EXTRA_PLUGIN,
  HOME_SKILL,
  PROBE_MODEL,
  facts,
  newScript,
  outcomes,
  parseShell,
  record,
  fact,
  runCommand,
  shellScript,
  shq,
  startEgress,
  waitUntil,
  type Script,
  INHOUSE_ALWAYS,
  INHOUSE_ON_DEMAND,
  type ScriptState,
  type ShellProbe,
  type ShellResult,
} from './lib.ts'

const PROBES = '/opt/runner/probes'
const GW_PORT = Number(process.env.PROBE_GW_PORT ?? 0)
const GW_OK = 'GW_OK'
const NAMES = { gw: 'gw.inhouse-probe.example', own: 'own.inhouse-probe.example', loop: 'loop.inhouse-probe.example', meta: 'meta.inhouse-probe.example' }

const pool = readPool(readFileSync('/etc/passwd', 'utf8'))
const userNamed = (name: string): PoolUser => pool.find((u) => u.user === name)!
const host = createSessionHost(productionHostDeps(pool))

// ---------------------------------------------------------------------------------------------------------------------
// The container's addresses

function ownAddress(): string {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  throw new Error('no non-loopback IPv4 address')
}
function gateway(): string {
  for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f[1] === '00000000' && f[2]) return [6, 4, 2, 0].map((i) => parseInt(f[2]!.slice(i, i + 2), 16)).join('.')
  }
  throw new Error('no default route')
}
const OWN = ownAddress()
const GW = gateway()
const GW_URL = `http://${GW}:${GW_PORT}/probe.txt`

// ---------------------------------------------------------------------------------------------------------------------
// Processes, as root sees them

type Proc = { pid: number; uid: number; cmdline: string; cwd: string }
function procs(): Proc[] {
  const out: Proc[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const status = readFileSync(`/proc/${name}/status`, 'utf8')
      const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1])
      const cmdline = readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
      let cwd = ''
      try {
        cwd = readlinkSync(`/proc/${name}/cwd`)
      } catch {
        // A zombie has none.
      }
      out.push({ pid: Number(name), uid, cmdline, cwd })
    } catch {
      // Gone between the listing and the read.
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// The root runner and runs through it

const egress = await startEgress()
const rootLog: string[] = []
type Release = { ok: boolean; uid?: number; detail: string }
const rootReleases = new Map<string, Release>()
const releaseEvents = new EventEmitter()
let root: ChildProcess

function keepRootLine(line: string) {
  rootLog.push(line)
  if (!line.startsWith('{')) return
  const { type, sessionKey, uid, error } = JSON.parse(line) as Record<string, unknown>
  if (typeof sessionKey !== 'string' || typeof uid !== 'number' || (type !== 'session_user_released' && type !== 'session_user_quarantined')) return
  const receipt = { ok: type === 'session_user_released', uid, detail: type === 'session_user_released' ? `released uid ${uid}` : `quarantined uid ${uid}: ${error}` }
  rootReleases.set(sessionKey, receipt)
  releaseEvents.emit(sessionKey, receipt)
}

async function health(): Promise<{ ok: boolean; live: number; quarantinedUsers?: number } | null> {
  try {
    const res = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(2000) })
    return res.ok ? ((await res.json()) as { ok: boolean; live: number; quarantinedUsers?: number }) : null
  } catch {
    return null
  }
}

async function startRoot() {
  root = spawn('node', ['/opt/runner/dist/main.mjs'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', EGRESS_URL: `http://127.0.0.1:${egress.port}`, PORT: '8080', PROXY_PORT: '8081' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  createInterface({ input: root.stdout! }).on('line', keepRootLine)
  createInterface({ input: root.stderr! }).on('line', (line) => rootLog.push(line))
  root.on('exit', (code, signal) => rootLog.push(`root exited ${code ?? signal}`))
  await waitUntil(() => root.exitCode === null && health(), 'the root to answer /health', 30_000, 100)
}

/**
 * How agent runs go: through the root's API (the production path), or, while sessions can't start through the root,
 * as direct sessions (direct.ts, variant `plain`): the same guards, sandbox, CLI wrapper, pool user and host-prepared
 * folder, without the root's channel, proxy and token. `root.session-starts` says which, and fails while it's direct.
 */
let VIA: 'root' | 'direct' = 'root'

type Run = {
  chatId: string
  via: 'root' | 'direct'
  state: ScriptState
  events: RunEvent[]
  status: number
  body: string
  token: string
  /** A direct session's own lines (init, result, error), and what its release (kill, park, wipe) threw. */
  lines: Record<string, unknown>[]
  cleanup: string
}

function sdkMessages(events: RunEvent[]): Record<string, unknown>[] {
  return events.filter((e) => e.type === 'sdk').map((e) => (e as { message: Record<string, unknown> }).message)
}
type Init = { tools: string[]; skills: string[]; plugins: { name: string }[]; slash_commands: string[] }
function directInitOf(lines: Run['lines']): Init | undefined {
  const l = lines.find((x) => x.type === 'init') as (Omit<Init, 'plugins'> & { plugins: string[] }) | undefined
  return l && { ...l, plugins: l.plugins.map((name) => ({ name })) }
}
const initOf = (r: Run): Init | undefined =>
  r.via === 'root' ? (sdkMessages(r.events).find((m) => m.type === 'system' && m.subtype === 'init') as Init | undefined) : directInitOf(r.lines)
const terminalOf = (r: Run): { type: string; reason?: string } | undefined => {
  if (r.via === 'root') return r.events.findLast((e) => e.type === 'finished' || e.type === 'failed')
  const res = r.lines.find((x) => x.type === 'result')
  return res ? { type: 'finished' } : { type: 'failed', reason: 'session_crashed', ...(r.lines.find((x) => x.type === 'error') ?? {}) }
}

/** The stream ends first; wait for the pool to report a completed release or quarantine for this chat. */
async function releaseOf(r: Run): Promise<Release> {
  if (r.via === 'direct') return { ok: r.cleanup === '', uid: agentUser(r.chatId).uid, detail: r.cleanup || 'direct release passed' }
  if (r.status !== 202) return { ok: false, detail: `POST /runs returned ${r.status}: ${r.body}` }
  try {
    // Cache the event as it may already be here by the time the caller inspects the stream.
    return rootReleases.get(r.chatId) ?? ((await once(releaseEvents, r.chatId, { signal: AbortSignal.timeout(30_000) }))[0] as Release)
  } catch {
    return { ok: false, detail: `no release event for ${r.chatId}` }
  }
}

/** Starts one run through the root's API; `done` settles once its stream has ended. */
function startRun(opts: { chatId: string; script: Script; prompt?: string; webFetchDomains?: string[]; outputFormat?: RunStart['outputFormat'] }): { run: Run; done: Promise<Run> } {
  const state = newScript(opts.script)
  const token = `probe_${randomBytes(24).toString('hex')}`
  const run: Run = { chatId: opts.chatId, via: VIA, state, events: [], status: 0, body: '', token, lines: [], cleanup: '' }
  if (VIA === 'direct') {
    const done = spawnDirect(opts.chatId, agentUser(opts.chatId), 'plain', { prompt: opts.prompt ?? 'Run the probe.', webFetchDomains: opts.webFetchDomains ?? [] }, state).then((d) => {
      Object.assign(run, { status: 200, lines: d.lines, body: d.raw, cleanup: d.cleanup })
      return run
    })
    return { run, done }
  }
  // A probe that runs the same chat twice waits for the first release before it starts the second run.
  rootReleases.delete(opts.chatId)
  egress.byToken.set(token, state)
  const done = (async () => {
    const res = await fetch('http://127.0.0.1:8080/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
      body: JSON.stringify({
        runId: `r${randomBytes(8).toString('hex')}`,
        chatId: opts.chatId,
        sessionId: randomUUID(),
        resume: false,
        prompt: opts.prompt ?? 'Run the probe.',
        model: PROBE_MODEL,
        sideModel: PROBE_MODEL,
        systemPrompt: '',
        attachments: [],
        expect: null,
        effort: 'low',
        maxTurns: 20,
        maxBudgetUsd: 1,
        runToken: token,
        webFetchDomains: opts.webFetchDomains ?? [],
        fileCaps: { maxFileBytes: 1_000_000, maxFilesPerTurn: 10, maxRestoreBytes: 1_000_000, allowedTypes: ['text/plain'] },
        ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
      } satisfies RunStart),
    })
    run.status = res.status
    const text = await res.text()
    run.body = text
    // Protocol v2: admitted (202), the run's events come to the egress; the run is over at its `released`.
    if (res.status === 202) {
      await Promise.race([state.released, new Promise<void>((r) => setTimeout(r, 10 * 60_000).unref())])
      run.events = state.pushed.filter((e) => e.type !== 'released' && e.type !== 'heartbeat') as RunEvent[]
    }
    return run
  })()
  return { run, done }
}

let diagnosed = false
/** The first crashed session: the entry started as the root starts it, and its whole stderr printed. */
async function diagnoseSession() {
  if (diagnosed) return
  diagnosed = true
  const u = userNamed('s39')
  const { workDir, home } = await host.prepareFolder('p-diag', u)
  const r = await runCommand('node', ['--disable-sigusr1', '/opt/runner/dist/session/main.mjs'], { uid: u.uid, gid: u.gid, cwd: workDir, env: sessionEnv({ uid: u.uid, gid: u.gid, user: u.user, home, workDir }, 8081), timeoutMs: 10_000 })
  fact('session-entry.diagnosis', `exit ${r.code}: ${r.out.slice(0, 1500)}`)
  await host.killAll(u)
  await host.parkFolder('p-diag')
}

/** A run must end `finished` with no model misses, and every Bash call in it must have its audit entry on the stream. */
function checkRun(name: string, r: Run, bashSteps: number[]) {
  const t = terminalOf(r)
  const audited = new Set(r.events.filter((e) => e.type === 'audit').map((e) => (e as { entry: { toolUseId: string } }).entry.toolUseId))
  // A direct session has no stream: its audit hook is proven by the audit probe instead.
  const missing = r.via === 'direct' ? [] : bashSteps.map((i) => r.state.ids[i]!).filter((id) => !audited.has(id))
  const ok = r.status === (r.via === 'root' ? 202 : 200) && t?.type === 'finished' && r.state.misses.length === 0 && missing.length === 0
  record(`${name}.run`, ok, `via ${r.via}, status ${r.status}, end ${JSON.stringify(t)?.slice(0, 200)}, misses ${JSON.stringify(r.state.misses)}, Bash calls without an audit entry ${JSON.stringify(missing)}`)
}

/** Init's name for a tool `tools:` names otherwise: the engine still reports the Agent tool under its old name. */
const TOOL_ALIASES: Record<string, string> = { Task: 'Agent' }

const result = (r: Run, step: number) => r.state.results.get(r.state.ids[step]!)
const bash = (command: string, extra: Record<string, unknown> = {}) => () => ({ tool: 'Bash', input: { command, description: 'Probe', timeout: 120_000, ...extra } })

/**
 * Judges sub-probes: each must not leak in the agent's run and must leak in the run with the guard off. `observe`
 * entries are printed as facts only.
 */
function judge(group: string, real: Map<string, ShellResult>, off: Map<string, ShellResult> | null, checks: { name: string; leak?: (r: ShellResult) => boolean }[]) {
  for (const c of checks) {
    const r = real.get(c.name)
    if (!c.leak) {
      fact(`${group}.${c.name}`, r ? `rc=${r.rc} ${r.out}` : 'no output')
      continue
    }
    if (!r) {
      record(`${group}.${c.name}`, false, 'the sub-probe printed nothing')
      continue
    }
    const o = off?.get(c.name)
    const leaked = c.leak(r)
    const seenOff = off === null ? true : o !== undefined && c.leak(o)
    record(`${group}.${c.name}`, !leaked && seenOff, `agent: rc=${r.rc} ${r.out.slice(0, 200)} | guard off: ${o ? `rc=${o.rc} ${seenOff ? 'leak seen' : 'NO LEAK SEEN: the probe cannot detect this'}` : 'n/a'}`)
  }
}

const rootShell = (script: string, env: Record<string, string> = {}, cwd = '/') => runCommand('bash', ['-c', script], { cwd, env: { PATH: '/usr/local/bin:/usr/bin:/bin', ...env } }).then((r) => parseShell(r.out))
const userShell = (u: PoolUser, script: string, cwd = '/tmp') => runCommand('bash', ['-c', script], { uid: u.uid, gid: u.gid, cwd }).then((r) => parseShell(r.out))

/**
 * `curl -sS -m <secs> <url>` without curl (the image has none): python's urllib prints the start of the body (an HTTP
 * error's too), or one line for any other failure, so several calls fit one sub-probe's output.
 * `env`: proxied as the environment says. urllib reads `no_proxy` as name suffixes, so an address in one of the private
 * ranges the sandbox lists there still goes to the proxy. `direct`: never proxied (curl's `--noproxy '*'`). `proxy`:
 * `no_proxy` dropped first, so every host goes to the proxy when one is set (curl's `--noproxy ''`).
 */
const GET = `import os, sys, urllib.request as u
via, url, secs, most = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])
if via == "proxy":
    os.environ.pop("no_proxy", None)
    os.environ.pop("NO_PROXY", None)
opener = u.build_opener(u.ProxyHandler({}) if via == "direct" else u.ProxyHandler())
try:
    r = opener.open(url, timeout=secs)
except u.HTTPError as e:
    r = e
except Exception as e:
    sys.exit("ERR " + type(e).__name__ + " " + str(e)[:80])
print(r.read().decode(errors="replace")[:most])`
/** A process's fds 3 and 4 by /proc, as the caller's uid: `<fd> <link>` or `<fd> <errno>`, then whether an open works. */
const FD_VIEW = `import os, sys, errno
for f in (3, 4):
    p = "/proc/%s/fd/%d" % (sys.argv[1], f)
    try:
        print(f, os.readlink(p))
    except OSError as e:
        print(f, errno.errorcode.get(e.errno, e.errno))
    try:
        os.close(os.open(p, os.O_RDWR))
        print(f, "OPEN")
    except OSError as e:
        print(f, "open", errno.errorcode.get(e.errno, e.errno))`
const get = (url: string, via: 'env' | 'direct' | 'proxy' = 'env', secs = 8, most = 120) => `python3 -c ${shq(GET)} ${via} ${shq(url)} ${secs} ${most}`

// ---------------------------------------------------------------------------------------------------------------------
// Probes

async function probeSharedWritable() {
  // The brief's `find / -xdev -perm -0002 -type d`, and the same on every other mount but /proc and /sys (tmpfs mounts
  // such as /dev/shm are their own filesystems). -prune: the top-most world-writable folders.
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8')
    .split('\n')
    .map((l) => l.split(' ')[4])
    .filter((m): m is string => !!m && !/^\/(proc|sys)(\/|$)/.test(m) && !m.startsWith(PROBES))
  const found = new Set<string>()
  for (const m of new Set(['/', ...mounts])) {
    try {
      if (!statSync(m).isDirectory()) continue
    } catch {
      continue
    }
    const r = await runCommand('find', [m, '-xdev', '-perm', '-0002', '-type', 'd', '-prune'])
    for (const p of r.out.split('\n')) if (p.startsWith('/') && !p.includes(': ')) found.add(p)
  }
  const expected = SHARED_WRITABLE.filter((d) => existsSync(d))
  const listed = [...found].sort()
  fact('shared-writable.find', listed.join(' '))
  fact('shared-writable.missing-from-image', SHARED_WRITABLE.filter((d) => !existsSync(d)).join(' ') || 'none')
  record('shared-writable.equals-list', JSON.stringify(listed) === JSON.stringify([...expected].sort()), `found ${JSON.stringify(listed)}, SHARED_WRITABLE (present) ${JSON.stringify(expected)}`)
  const notSticky = listed.filter((d) => (statSync(d).mode & 0o1000) === 0)
  record('shared-writable.sticky', notSticky.length === 0, `not sticky: ${JSON.stringify(notSticky)}`)
  const hard = readFileSync('/proc/sys/fs/protected_hardlinks', 'utf8').trim()
  fact('fs.protected_hardlinks', hard)
  fact('fs.protected_symlinks', readFileSync('/proc/sys/fs/protected_symlinks', 'utf8').trim())
  record('fs.protected_hardlinks', hard === '1', `protected_hardlinks = ${hard}`)
}

async function probeEgress() {
  const probes: ShellProbe[] = [
    { name: 'allowlisted-name-to-private-address', cmd: get(`http://${NAMES.gw}:${GW_PORT}/probe.txt`) },
    { name: 'unlisted-public-name', cmd: get('http://example.com/', 'env', 8, 400) },
    { name: 'ip-literal', cmd: `${get(GW_URL)}; ${get(GW_URL, 'proxy')}` },
    { name: 'no-proxy', cmd: get(GW_URL, 'direct') },
    { name: 'dev-tcp', cmd: `exec 3<>/dev/tcp/${GW}/${GW_PORT} && printf 'GET /probe.txt HTTP/1.0\\r\\n\\r\\n' >&3 && cat <&3` },
    { name: 'python', cmd: `python3 -c 'import urllib.request;print(urllib.request.urlopen("${GW_URL}",timeout=8).read().decode())'` },
    { name: 'own-name-root-api', cmd: get(`http://${NAMES.own}:8080/health`) },
    { name: 'own-address-root-api', cmd: `${get(`http://${OWN}:8080/health`, 'proxy')}; ${get(`http://${OWN}:8080/health`, 'direct')}` },
    {
      name: 'loopback-root-api',
      cmd: [get('http://127.0.0.1:8080/health', 'proxy'), get('http://127.0.0.1:8080/health', 'direct'), get('http://localhost:8080/health', 'proxy'), get(`http://${NAMES.loop}:8080/health`)].join('; '),
    },
    {
      name: 'root-proxy-8081',
      cmd: [get('http://127.0.0.1:8081/nope', 'proxy'), get('http://127.0.0.1:8081/nope', 'direct'), get(`http://${NAMES.loop}:8081/nope`), get(`http://${OWN}:8081/nope`, 'proxy')].join('; '),
    },
    { name: 'metadata', cmd: `${get('http://169.254.169.254/', 'proxy', 4)}; ${get(`http://${NAMES.meta}/`, 'env', 4)}` },
    { name: 'proxy-env', cmd: `env | grep -i proxy | sed 's/=.*//' | sort | tr '\\n' ' '` },
  ]
  const script = shellScript(probes)
  const { done } = startRun({ chatId: 'p-egress', script: { steps: [bash(script)] }, webFetchDomains: [NAMES.gw, NAMES.own, NAMES.loop, NAMES.meta] })
  const r = await done
  checkRun('egress', r, [0])
  const real = parseShell(result(r, 0)?.text ?? '')
  const off = await rootShell(script)
  const gwLeak = (x: ShellResult) => x.out.includes(GW_OK)
  const rootApi = (x: ShellResult) => x.out.includes('"quarantinedUsers"')
  judge('egress', real, off, [
    { name: 'allowlisted-name-to-private-address' },
    { name: 'unlisted-public-name', leak: (x) => x.out.includes('Example Domain') },
    { name: 'ip-literal', leak: gwLeak },
    { name: 'no-proxy', leak: gwLeak },
    { name: 'dev-tcp', leak: gwLeak },
    { name: 'python', leak: gwLeak },
    { name: 'own-name-root-api', leak: rootApi },
    { name: 'own-address-root-api', leak: rootApi },
    { name: 'loopback-root-api', leak: rootApi },
    { name: 'root-proxy-8081', leak: (x) => x.out.includes('no such route') },
    { name: 'metadata' },
    { name: 'proxy-env' },
  ])
  const named = real.get('allowlisted-name-to-private-address')
  fact('egress.public-looking-name-to-private-address', named?.out.includes(GW_OK) ? 'connects (the sandbox proxy refuses only local addresses: loopback, link-local, its own)' : `refused: ${named?.out}`)
}

async function probeNoUnsandboxedRetry() {
  const cmd = `head -c 80 /opt/runner/package.json; echo; tr '\\0' ' ' < /proc/1/cmdline`
  const { done } = startRun({ chatId: 'p-retry', script: { steps: [bash(cmd, { dangerouslyDisableSandbox: true }), bash(cmd)] } })
  const r = await done
  checkRun('no-unsandboxed-retry', r, [])
  const off = await runCommand('bash', ['-c', cmd], { uid: userNamed('s50').uid, gid: userNamed('s50').gid, cwd: '/tmp' })
  const leak = (t: string) => t.includes('inhouse-runner')
  for (const [i, label] of [
    [0, 'with-dangerouslyDisableSandbox'],
    [1, 'plain'],
  ] as const) {
    const t = result(r, i)?.text ?? ''
    record(`no-unsandboxed-retry.${label}`, result(r, i) !== undefined && !leak(t) && leak(off.out), `agent: ${t.slice(0, 200)} | guard off (session user, unsandboxed): ${leak(off.out) ? 'leak seen' : 'NO LEAK SEEN'}`)
  }
}

function claudeDirLeaks(workDir: string): string[] {
  const leaks: string[] = []
  const claude = join(workDir, '.claude')
  const st = existsSync(claude) ? lstatSync(claude) : null
  if (!st || !st.isDirectory() || st.uid !== 0) leaks.push('.claude is gone or not root-owned')
  for (const f of ['settings.json', 'settings.local.json']) {
    const p = join(claude, f)
    if (!existsSync(p) || readFileSync(p, 'utf8') !== '{}') leaks.push(`.claude/${f} changed`)
  }
  // Made in .claude/ and then moved with it still counts.
  const moved = join(workDir, '.claude-moved')
  if (existsSync(join(claude, 'x')) || existsSync(join(moved, 'x'))) leaks.push('.claude/x made')
  if (existsSync(join(claude, 'skills', 'evil')) || existsSync(join(moved, 'skills', 'evil'))) leaks.push('.claude/skills/evil made')
  if (existsSync(join(workDir, '.claude-moved'))) leaks.push('.claude moved')
  const mcp = join(workDir, '.mcp.json')
  if (!existsSync(mcp) || readFileSync(mcp, 'utf8') !== '{}') leaks.push('.mcp.json changed')
  for (const p of ['/opt/inhouse/plugin/x', '/opt/runner/x']) if (existsSync(p)) leaks.push(`${p} made`)
  return leaks
}

async function probeClaudeDir() {
  const probes: ShellProbe[] = [
    { name: 'touch', cmd: 'touch .claude/x' },
    { name: 'mkdir-skill', cmd: 'mkdir -p .claude/skills/evil' },
    { name: 'write-settings', cmd: `echo '{"permissions":{"allow":["Bash"]}}' > .claude/settings.json` },
    { name: 'write-local-settings', cmd: `echo '{"x":1}' > .claude/settings.local.json` },
    { name: 'mv', cmd: 'mv .claude .claude-moved' },
    { name: 'rm', cmd: 'rm -rf .claude' },
    { name: 'mcp-json', cmd: `echo '{"mcpServers":{"x":{"type":"http","url":"http://x"}}}' > .mcp.json` },
    { name: 'rm-mcp-json', cmd: 'rm -f .mcp.json' },
    { name: 'plugin', cmd: 'touch /opt/inhouse/plugin/x' },
    { name: 'runner', cmd: 'touch /opt/runner/x' },
    { name: 'home-skill', cmd: `mkdir -p "$HOME/.claude/skills/${HOME_SKILL}" && printf -- '---\\nname: ${HOME_SKILL}\\ndescription: probe\\n---\\nprobe\\n' > "$HOME/.claude/skills/${HOME_SKILL}/SKILL.md" && echo made` },
    { name: 'home-settings', cmd: `mkdir -p "$HOME/.claude" && printf '{"permissions":{"allow":["Bash"]}}' > "$HOME/.claude/settings.json" && echo made` },
  ]
  const script = shellScript(probes)
  const wd = sessionPaths('p-claude').workDir
  // Twice: as written, where the permission rules read the paths and refuse the call before it runs, and encoded, as a
  // script that hides them would arrive: then only the sandbox and the folder's owners stand in the way.
  const encoded = `echo ${Buffer.from(script).toString('base64')} | base64 -d | bash`
  const { done } = startRun({
    chatId: 'p-claude',
    script: {
      steps: [bash(script), bash(encoded), () => ({ tool: 'Write', input: { file_path: `${wd}/.claude/settings.json`, content: '{"x":1}' } }), () => ({ tool: 'Write', input: { file_path: `${wd}/.mcp.json`, content: '{"x":1}' } })],
    },
  })
  const r = await done
  checkRun('claude-dir', r, [1])
  fact('claude-dir.as-written', result(r, 0)?.text.replace(/\s+/g, ' ').slice(0, 200) ?? 'no result')
  const real = parseShell(result(r, 1)?.text ?? '')
  if (real.size === 0) fact('claude-dir.encoded', result(r, 1)?.text.replace(/\s+/g, ' ').slice(0, 300) ?? 'no result')
  fact('claude-dir.write-tool', `${result(r, 2)?.text.slice(0, 200)} | ${result(r, 3)?.text.slice(0, 200)}`)
  // What the agent's run changed, read from outside (as root) on the real paths, before any guard-off run.
  const leaks = claudeDirLeaks(wd)
  // Each sub-probe's guard-off run: its one command as root, in its own folder the real host laid out the same way, so
  // no command's effect hides another's (a `mv` would hide a `touch`). Each must make the change the agent's run didn't.
  const kinds: Record<string, string> = {
    touch: '.claude/x made',
    'mkdir-skill': '.claude/skills/evil made',
    'write-settings': '.claude/settings.json changed',
    'write-local-settings': '.claude/settings.local.json changed',
    mv: '.claude moved',
    rm: '.claude is gone or not root-owned',
    'mcp-json': '.mcp.json changed',
    'rm-mcp-json': '.mcp.json changed',
    plugin: '/opt/inhouse/plugin/x made',
    runner: '/opt/runner/x made',
  }
  // `/opt/runner` is in the sandbox's denyRead: bwrap mounts an empty folder over it, so a write there lands in that
  // mask and Bash reports success. Only the real path, read from outside, says whether anything was written.
  const notes: Record<string, string> = { runner: ' (rc=0 is the write landing in the sandbox mask over /opt/runner)' }
  for (const [i, p] of probes.filter((x) => !x.name.startsWith('home-')).entries()) {
    const kind = kinds[p.name]!
    const offKey = `p-claude-off-${i}`
    const offDir = await host.prepareFolder(offKey, userNamed('s49'))
    await runCommand('bash', ['-c', p.cmd], { cwd: offDir.workDir, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: join(offDir.workDir, 'home-off') } })
    const offSeen = claudeDirLeaks(offDir.workDir).includes(kind)
    rmSync('/opt/inhouse/plugin/x', { force: true })
    rmSync('/opt/runner/x', { force: true })
    await host.parkFolder(offKey)
    const x = real.get(p.name)
    record(
      `claude-dir.${p.name}`,
      x !== undefined && !leaks.includes(kind) && offSeen,
      `agent: ${x ? `rc=${x.rc} ${x.out.slice(0, 120)}` : 'no output'}${notes[p.name] ?? ''} | real path: ${leaks.includes(kind) ? `CHANGED (${kind})` : 'unchanged'} | guard off (root, own layout): ${offSeen ? `${kind}` : 'NOT SEEN: the probe cannot detect this'}`,
    )
  }
  fact('claude-dir.agent-changes', JSON.stringify(leaks))
  // The home: the same script as root with HOME a scratch folder. The real home is the user's own, outside the session
  // folder, and read-only to Bash: it can't plant a skill or a settings file there for the CLI to load.
  const selfKey = 'p-claude-self'
  const self = await host.prepareFolder(selfKey, userNamed('s49'))
  const off = await rootShell(shellScript(probes.filter((p) => p.name.startsWith('home-'))), { HOME: join(self.workDir, 'home-off') }, self.workDir)
  await host.parkFolder(selfKey)
  const made = (x: ShellResult) => x.out.includes('made')
  judge('claude-dir', real, off, probes.filter((p) => p.name.startsWith('home-')).map((p) => ({ name: p.name, leak: made })))

  // An empty HOME proves nothing about discovery. Both direct sessions start with a planted skill in HOME, but only
  // the positive control opts into user settings and all discovered skills. Read the actual SDK init, not a follow-up
  // request that can hit a chat whose release is still running.
  const input = { prompt: 'Run the probe.', webFetchDomains: [] }
  const guarded = await direct('home-skill-guarded', input, { steps: [] })
  const control = await direct('home-skill-open', input, { steps: [] })
  const sourcesOpen = await direct('home-skill-sources-open', input, { steps: [] })
  const skillsOpen = await direct('home-skill-skills-open', input, { steps: [] })
  const discover = (d: typeof guarded) => {
    const init = directInitOf(d.lines)
    if (!Array.isArray(init?.skills) || !Array.isArray(init.slash_commands)) return undefined
    return [...init.skills, ...init.slash_commands].filter((s) => s.replace(/^\//, '') === HOME_SKILL)
  }
  const finished = (d: typeof guarded) => d.cleanup === '' && d.state.misses.length === 0 && d.lines.some((l) => l.type === 'result' && l.subtype === 'success' && l.isError === false)
  const loaded = discover(guarded)
  const offLoaded = discover(control)
  const judgeInit = (d: typeof guarded, skills: string[] | undefined) =>
    `${finished(d) ? 'finished' : `run or cleanup failed (${d.cleanup || d.raw.slice(-200)})`}, matching init entries ${JSON.stringify(skills) ?? 'unavailable'}`
  record(
    'claude-dir.home-skill-not-loaded',
    finished(guarded) && finished(control) && loaded?.length === 0 && (offLoaded?.length ?? 0) > 0,
    `guarded: ${judgeInit(guarded, loaded)} | discovery enabled: ${judgeInit(control, offLoaded)}`,
  )
  // Each layer alone, the other taken out: a layer that doesn't hold by itself shows here even while the other hides it.
  // Each is judged on what it does. settingSources: [] means the skill is never discovered: not in init, not in any
  // model request. The `skills` allowlist is a context filter (the SDK's own words): an unlisted skill can still be
  // discovered and listed in init, but the model's listing leaves it out. So that layer's observable is the model's
  // requests; its init entries are printed as a fact.
  const modelSees = (d: typeof guarded) => JSON.stringify(d.state.requests).includes(HOME_SKILL)
  const controlLoads = finished(control) && (offLoaded?.length ?? 0) > 0 && modelSees(control)
  const bothOff = `both off: ${controlLoads ? 'in init and in the model request' : `NOT SEEN (init ${JSON.stringify(offLoaded)}, model request ${modelSees(control)}): the probe cannot detect this`}`
  const sl = discover(skillsOpen)
  record(
    'claude-dir.home-skill-sources-alone',
    finished(skillsOpen) && sl?.length === 0 && !modelSees(skillsOpen) && controlLoads,
    `settingSources: [] kept, skills: 'all': ${judgeInit(skillsOpen, sl)}, model request names it ${modelSees(skillsOpen)} | ${bothOff}`,
  )
  fact('claude-dir.home-skill-allowlist-alone.init', `settingSources: ['user'], allowlist kept: ${judgeInit(sourcesOpen, discover(sourcesOpen))}`)
  const listingOk = finished(sourcesOpen) && sourcesOpen.state.requests.length > 0 && !modelSees(sourcesOpen) && controlLoads
  const listingDetail = `the skills allowlist kept, settingSources: ['user']: model requests ${sourcesOpen.state.requests.length}, a request names it ${modelSees(sourcesOpen)} | ${bothOff}`
  // Invocation: the skill typed by name, with the allowlist alone, and with both layers off (the control: it must run).
  const typed = { prompt: `/${HOME_SKILL}`, webFetchDomains: [] }
  const sourcesTyped = await direct('home-skill-sources-open', typed, { steps: [] })
  const controlTyped = await direct('home-skill-open', typed, { steps: [] })
  const ended = (d: typeof guarded) => d.cleanup === '' && d.lines.some((l) => l.type === 'result')
  const resultText = (d: typeof guarded) => d.lines.filter((l) => l.type === 'result').map((l) => String(l.text ?? '').slice(0, 160)).join(' | ')
  const typedInvoked = expanded(sourcesTyped.state.requests, HOME_SKILL)
  const controlInvoked = finished(controlTyped) && expanded(controlTyped.state.requests, HOME_SKILL)
  const typedDetail = `typed /${HOME_SKILL}, allowlist alone: ${ended(sourcesTyped) ? 'ended' : 'DID NOT END'}, ${seen(sourcesTyped.state.requests, HOME_SKILL)}, result ${resultText(sourcesTyped)} | both off: ${seen(controlTyped.state.requests, HOME_SKILL)}`
  fact('claude-dir.home-skill-typed', typedDetail)
  if (controlInvoked && ended(sourcesTyped) && !typedInvoked) {
    record('claude-dir.home-skill-allowlist-alone', listingOk, `${listingDetail} | ${typedDetail}`)
  } else {
    // The allowlist alone is judged only on what it shows: the model's listing.
    record('claude-dir.home-skill-allowlist-alone-hides-from-listing', listingOk, listingDetail)
    if (controlInvoked && typedInvoked) fact('claude-dir.home-skill-allowlist-alone.invocation', `a typed /${HOME_SKILL} still runs with the allowlist alone (it filters the listing, not invocation); settingSources: [] keeps it out (home-skill-sources-alone)`)
    else markUnproven('claude-dir.home-skill-allowlist-alone.invocation', typedDetail)
  }
}

/** The guarded init (probeFacts), for the checks whose guard-off runs come later. */
let guardedInit: Init | undefined
const turnedOff = (commands: string[]) => commands.filter((c) => (BUNDLED_SKILLS_OFF as readonly string[]).includes(c.replace(/^\//, '')))
/** A probe whose control can't be shown: printed as unproven with why, never counted as a pass. */
const markUnproven = (name: string, why: string) => fact(name, `UNPROVEN: ${why}`)

async function probeFacts() {
  const probes: ShellProbe[] = [
    { name: 'shell', cmd: 'echo "SHELL=[$SHELL]"; getent passwd "$(id -u)"; id' },
    { name: 'tmpdir', cmd: 'echo "TMPDIR=$TMPDIR"; umask; touch "$TMPDIR/p" && ls -ld "$TMPDIR" && echo wrote' },
    { name: 'ns', cmd: 'readlink /proc/self/ns/ipc /proc/self/ns/pid /proc/self/ns/net /proc/self/ns/user /proc/self/ns/mnt | tr "\\n" " "' },
    { name: 'unix-socket', cmd: `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); print("made")'; python3 -c 'import socket; socket.socketpair(); print("made pair")'` },
    { name: 'seccomp', cmd: 'grep -E "Seccomp|NoNewPrivs" /proc/self/status | tr "\\n" " "' },
    { name: 'ps', cmd: 'ps -eo pid,user,args --no-headers | head -20' },
    { name: 'sysctl', cmd: 'cat /proc/sys/fs/protected_hardlinks /proc/sys/fs/protected_symlinks | tr "\\n" " "' },
    // P6a W3: our three skills reach the image, readable by the session, and not writable by it (Q7).
    { name: 'skill-files', cmd: 'for s in pdf word spreadsheet; do f=/opt/inhouse/plugin/skills/$s/SKILL.md; test -f "$f" && test -r "$f" && echo "$s readable"; test -w "$f" && echo "$s WRITABLE"; done; true' },
  ]
  const script = shellScript(probes)
  const { done } = startRun({ chatId: 'p-facts', script: { steps: [bash(script)] } })
  const r = await done
  checkRun('facts', r, [0])
  const real = parseShell(result(r, 0)?.text ?? '')
  const off = await userShell(userNamed('s50'), script)
  // The filter refuses a named Unix socket; a socketpair reaches nothing outside its maker, and is left alone.
  judge('facts', real, off, [{ name: 'shell' }, { name: 'tmpdir' }, { name: 'ns' }, { name: 'unix-socket', leak: (x) => x.out.split('\n').includes('made') }, { name: 'seccomp' }, { name: 'ps' }, { name: 'sysctl' }])
  const skillFiles = real.get('skill-files')?.out ?? ''
  record(
    'facts.skill-files-present-and-read-only',
    ['pdf', 'word', 'spreadsheet'].every((s) => skillFiles.includes(`${s} readable`)) && !skillFiles.includes('WRITABLE'),
    `agent saw: ${skillFiles.replace(/\s+/g, ' ')}`,
  )
  const shell = real.get('shell')
  fact('bash-under-nologin-without-SHELL', shell && shell.rc === 0 ? `works (${shell.out.replace(/\n/g, ' ')})` : `FAILED: R1 must add SHELL=/bin/bash (${shell?.out})`)
  record('facts.bash-runs-under-nologin', shell?.rc === 0, shell?.out ?? 'no output')
  const mine = ['ipc', 'pid', 'net'].map((n) => readlinkSync(`/proc/self/ns/${n}`))
  const theirs = real.get('ns')?.out ?? ''
  fact('ipc-namespace', theirs.includes(mine[0]!) ? `shared with the container (${mine[0]})` : `own (${theirs.split(' ')[0]}; container ${mine[0]})`)
  fact('pid-namespace', theirs.includes(mine[1]!) ? 'shared with the container' : 'own')
  fact('net-namespace', theirs.includes(mine[2]!) ? 'shared with the container' : 'own')
  const init = initOf(r)
  if (init) {
    const tools = init.tools.map((t) => TOOL_ALIASES[t] ?? t)
    const outside = tools.filter((t) => !(BUILT_IN_TOOLS as readonly string[]).includes(t) && !t.startsWith(`mcp__${INHOUSE_MCP_SERVER}__`))
    fact('init.tools', JSON.stringify(tools))
    fact('init.tools-missing-of-the-20', JSON.stringify(BUILT_IN_TOOLS.filter((t) => !tools.includes(t))))
    record('init.tools-within-the-20', outside.length === 0, `outside the 20: ${JSON.stringify(outside)}`)
    fact('init.skills', JSON.stringify(init.skills))
    record('init.skills-exactly-allowed', JSON.stringify([...init.skills].sort()) === JSON.stringify([...ALLOWED_SKILLS].sort()), `skills ${JSON.stringify(init.skills)}, allowed ${JSON.stringify(ALLOWED_SKILLS)}`)
    const plugins = init.plugins.map((p) => p.name).sort()
    fact('init.plugins', JSON.stringify(plugins))
    // Exactly ours. `sec-default` is never listed without managed settings (P0 S2's record; the same on 0.3.328).
    // Guard off: the built-in plugins not turned off and one we don't ship added; init must then list the one we don't
    // ship, so the check can see a plugin that isn't ours.
    const offRun = await direct('plugins-not-off', { prompt: 'Run the probe.', webFetchDomains: [] }, { steps: [] })
    const offPlugins = (offRun.lines.find((l) => l.type === 'init')?.plugins as string[] | undefined) ?? []
    fact('init.plugins-guard-off', JSON.stringify(offPlugins))
    const offSeen = offPlugins.some((n) => n.split('@')[0] === EXTRA_PLUGIN)
    record(
      'init.plugins-only-ours',
      JSON.stringify(plugins) === JSON.stringify([PLUGIN_NAME]) && offSeen,
      `${JSON.stringify(plugins)} | guard off (built-ins on, ${EXTRA_PLUGIN} added): ${offSeen ? JSON.stringify(offPlugins) : `NOT SEEN: ${JSON.stringify(offPlugins)}`}`,
    )
    fact('init.slash_commands', JSON.stringify(init.slash_commands))
    // Judged in probeCodeReview, next to the guard-off runs that list the turned-off commands.
    guardedInit = init
  } else record('init.seen', false, 'no init message on the stream')
}

async function probeLongTmpdir() {
  const chatId = `p-long-${'x'.repeat(57)}`
  const { done } = startRun({ chatId, script: { steps: [bash('echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe-long" && echo wrote-$((40+2)); ls -ld "$TMPDIR"')] } })
  const r = await done
  checkRun('long-tmpdir', r, [0])
  const out = result(r, 0)?.text ?? 'no output'
  const wrote = /^wrote-42$/m.test(out)
  fact('tmpdir.long-chat-id', out)
  // The temp folder is named by the pool user, so the longest chat id leaves room for the sandbox's sockets in it.
  record('long-tmpdir.bash-runs', wrote, out.slice(0, 300))
  const release = await releaseOf(r)
  const owner = pool.find((u) => u.uid === release.uid)
  const tmp = owner && userPaths(owner.user).tmp
  const bashTmpdir = /^TMPDIR=(.+)$/m.exec(out)?.[1]
  const usedOwnTmp = tmp !== undefined && (bashTmpdir === tmp || bashTmpdir?.startsWith(`${tmp}/`) === true)
  const ownLeft = tmp ? await runCommand('find', [tmp, '-xdev', '-mindepth', '1', '-print', '-quit']) : undefined
  const sharedLeft = await runCommand('find', ['/tmp', '/var/tmp', '/dev/shm', '-xdev', '-name', 'probe-long'])
  record(
    'long-tmpdir.wiped-at-release',
    wrote && usedOwnTmp && release.ok && ownLeft?.code === 0 && ownLeft.out.trim() === '',
    `${release.detail}; marker written in own TMPDIR: ${wrote && usedOwnTmp}; own tmp: ${ownLeft ? `${ownLeft.code}, ${ownLeft.out.trim() || 'empty'}` : 'unknown'}`,
  )
  // Bash can't write the shared folders, so no marker was ever there to wipe: a fact. The wipe of the shared folders is
  // proven by the wipe.* probes, on files a pool uid did leave there.
  fact('long-tmpdir.shared-folders', `status ${sharedLeft.code}, ${sharedLeft.out.trim() || 'no marker'}`)
}

/**
 * A typed skill the CLI runs goes to the model; one it refuses ends without a model request (the CLI answers it
 * itself). So the detector is "the typed command reached the model", and each run says what it saw.
 */
/**
 * The CLI's marker for a skill it expanded inline (`/dataviz`), or, for a bundled skill it hands over as its own first
 * user text (`/code-review` on 0.3.328, seen in CI), a phrase from that skill's body.
 */
const SKILL_BODY: Record<string, string> = { 'code-review': 'diff pass (bugs)', [HOME_SKILL]: 'Say hello.' }
const expanded = (requests: unknown[], name: string) => {
  const t = JSON.stringify(requests)
  const body = SKILL_BODY[name]
  return t.includes(`<command-name>/${name}</command-name>`) || t.includes(`<command-message>${name}`) || (body !== undefined && firstUserText(requests).includes(body))
}
const seen = (requests: unknown[], name: string) => `model requests ${requests.length}, expansion marker ${expanded(requests, name)}`
/** The first request's user text, minus system reminders: what the model was handed for the typed command. */
const firstUserText = (requests: unknown[]) => {
  const msgs = ((requests[0] as { messages?: { role: string; content: unknown }[] } | undefined)?.messages ?? []).filter((m) => m.role === 'user')
  const texts = msgs.flatMap((m) => (typeof m.content === 'string' ? [m.content] : (m.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text ?? '')))
  return texts.filter((t) => !t.trimStart().startsWith('<system-reminder>')).join(' / ').replace(/\s+/g, ' ').slice(0, 300)
}
const resultTextOf = (r: Run) =>
  (r.via === 'root' ? sdkMessages(r.events).filter((m) => m.type === 'result').map((m) => m.result) : r.lines.filter((l) => l.type === 'result').map((l) => l.text))
    .map((x) => String(x ?? '').slice(0, 200))
    .join(' | ')

const DENIAL = 'disabled via skillOverrides'

async function probeCodeReview() {
  const r = await startRun({ chatId: 'p-cr', prompt: '/code-review', script: { steps: [] } }).done
  fact('code-review.typed', `${seen(r.state.requests, 'code-review')}, end ${JSON.stringify(terminalOf(r))?.slice(0, 200)}, result ${resultTextOf(r)}`)
  // Controls. The nearest: a skill we keep, typed the same way through the same guards, must reach the model. The
  // real one: /code-review with nothing of ours in the way (overrides removed; then the allowlist too).
  const dv = await startRun({ chatId: 'p-dv', prompt: '/dataviz', script: { steps: [] } }).done
  fact('code-review.control-dataviz-typed', `${seen(dv.state.requests, 'dataviz')}, result ${resultTextOf(dv)}`)
  const offs: { variant: string; reached: boolean; expanded: boolean; denied: boolean; commands: string[] }[] = []
  for (const variant of ['skills-not-off', 'skills-open'] as const) {
    const off = await direct(variant, { prompt: '/code-review', webFetchDomains: [] }, { steps: [] })
    const res = off.lines.filter((l) => l.type === 'result').map((l) => String(l.text ?? '').slice(0, 200)).join(' | ')
    fact(`code-review.guard-off.${variant}`, `${seen(off.state.requests, 'code-review')}, first user text "${firstUserText(off.state.requests)}", result ${res}`)
    const commands = (off.lines.find((l) => l.type === 'init')?.slash_commands as string[] | undefined) ?? []
    offs.push({ variant, reached: off.state.requests.length > 0, expanded: expanded(off.state.requests, 'code-review'), denied: res.includes(DENIAL), commands })
  }
  // The guarded run: no model request, the run finished, and the CLI's own denial names the override.
  const reached = r.state.requests.length > 0
  const ended = terminalOf(r)?.type === 'finished'
  const denied = resultTextOf(r).includes(DENIAL)
  const guardedOk = !reached && ended && denied
  const guardedDetail = `agent: ${reached ? 'REACHED THE MODEL' : 'no model request'}, run ${ended ? 'finished' : 'did not finish'}, denial ${denied ? `"${DENIAL}"` : 'MISSING'}`
  const control = offs.find((o) => o.reached && o.expanded && !o.denied)
  if (control || !guardedOk) {
    record('code-review.refused', guardedOk && control !== undefined, `${guardedDetail} | guard off: ${control ? `${control.variant} expanded it and reached the model` : 'no run expanded it'}`)
  } else {
    // The guard-off runs reach the model, but with no expansion marker: on this CLI /code-review isn't expanded inline
    // the way /dataviz is, so its run can't be told from the raw text passed on. The guarded run's denial is the CLI's
    // own word that the override refused it; that is not a control, so it stays unproven.
    markUnproven('code-review.refused', `${guardedDetail}; guard off: ${offs.map((o) => `${o.variant} reached the model ${o.reached}, expansion marker ${o.expanded}`).join(', ')} (the first user text is printed in code-review.guard-off.*)`)
  }

  // The turned-off commands: none in the guarded init; a guard-off run (overrides removed) lists them.
  const guardedOff = guardedInit ? turnedOff(guardedInit.slash_commands) : undefined
  const offListed = offs.map((o) => ({ variant: o.variant, listed: turnedOff(o.commands) })).filter((o) => o.listed.length > 0)
  if (guardedOff === undefined) record('init.no-turned-off-command', false, 'no guarded init (probeFacts)')
  else if (offListed.length > 0) record('init.no-turned-off-command', guardedOff.length === 0, `guarded: ${JSON.stringify(guardedOff)} | guard off: ${offListed.map((o) => `${o.variant} lists ${JSON.stringify(o.listed)}`).join(', ')}`)
  else if (guardedOff.length > 0) record('init.no-turned-off-command', false, `guarded lists ${JSON.stringify(guardedOff)}`)
  else markUnproven('init.no-turned-off-command', `none listed guarded; no guard-off run lists one either (${offs.map((o) => `${o.variant}: ${o.commands.length} commands`).join(', ')})`)
}

/** A's holder waits for `outputs/.go`: written however the probe ends, so a throw never leaves A's session up. */
async function probeIsolation() {
  const outputs = sessionPaths('p-iso-a').outputs
  try {
    await isolation()
  } finally {
    if (existsSync(outputs)) appendFileSync(join(outputs, '.go'), '')
  }
}

async function isolation() {
  const wa = sessionPaths('p-iso-a').workDir
  const a = startRun({
    chatId: 'p-iso-a',
    script: {
      steps: [
        bash(
          `echo CANARY_A_FILE > inputs/secret.txt; echo CANARY_A_TMPDIR > "$TMPDIR/secret"; echo CANARY_A_TMP > /tmp/iso-a-secret; ls -l inputs/secret.txt "$TMPDIR/secret"; ` +
            `CANARY_ENV=CANARY_A_ENVIRON sh -c 'while [ ! -e outputs/.go ]; do sleep 0.1; done' canary-A-cmdline-holder`,
          { timeout: 300_000 },
        ),
      ],
    },
  })
  let aEnded = false
  void a.done.then(() => (aEnded = true))
  const holder = await waitUntil(() => {
    if (aEnded) throw new Error(`A's run ended before its holder started: ${JSON.stringify(terminalOf(a.run))}`)
    // The holder itself, never a wrapper of A's Bash call: bwrap, the seccomp helper and the shells under them carry
    // the whole command (`CANARY_A_FILE` and all) at the end of command lines thousands of bytes long, past the 600 a
    // sub-probe prints, and none of them has the canary in its environment.
    return procs().find((p) => p.cmdline.includes('canary-A-cmdline-holder') && !p.cmdline.includes('CANARY_A_FILE') && p.uid !== 0)
  }, "A's holder process", 60_000)
  // By uid, not by working folder: root reads another uid's /proc/<pid>/cwd only with CAP_SYS_PTRACE, which Docker's
  // default set lacks.
  const aSession = procs().find((p) => p.uid === holder.uid && /session\/main\.mjs|probes\/direct\.mjs/.test(p.cmdline))
  fact('isolation.a', `holder pid ${holder.pid} uid ${holder.uid}, session pid ${aSession?.pid}`)
  // A's own home and temp folder. Bash can't write its home, so A's user puts the home canary there itself; the temp
  // canary is wherever A's `$TMPDIR` was (the folder, or one the CLI made in it).
  const aUser = pool.find((u) => u.uid === holder.uid)!
  const aOwn = userPaths(aUser.user)
  await runCommand('sh', ['-c', `echo CANARY_A_HOME > ${aOwn.home}/secret`], { uid: aUser.uid, gid: aUser.gid })
  // A shared /tmp canary the Read and Grep tools can find: A's Bash can't write /tmp (its sandbox; see isolation.a-wrote),
  // so A's uid writes it from outside, readable by every uid: only the permission rule stands in the way.
  await runCommand('sh', ['-c', 'echo CANARY_A_TMP > /tmp/iso-a-secret && chmod 0644 /tmp/iso-a-secret'], { uid: aUser.uid, gid: aUser.gid })
  // A opens its own temp folder (a chmod is the owner's to make) and leaves a world-readable file in it. Its parent is
  // root's, 0755 already. Then only the per-user Read rules stand between B's tools and the file.
  const aOpen = join(aOwn.tmp, 'open-secret')
  await runCommand('sh', ['-c', `chmod 0755 ${aOwn.tmp} && echo CANARY_A_OPEN > ${aOpen} && chmod 0644 ${aOpen}`], { uid: aUser.uid, gid: aUser.gid })
  const openByMode = await runCommand('cat', [aOpen], { uid: userNamed('s50').uid, gid: userNamed('s50').gid })
  fact('isolation.a-opened-tmp', `${aOwn.dir} ${(statSync(aOwn.dir).mode & 0o7777).toString(8)} root, ${aOwn.tmp} ${(statSync(aOwn.tmp).mode & 0o7777).toString(8)}; another uid's cat outside the sandbox: ${openByMode.out.trim()}`)
  const aTmpSecret = () => [join(aOwn.tmp, 'secret'), ...readdirSync(aOwn.tmp).map((d) => join(aOwn.tmp, d, 'secret'))].find((f) => existsSync(f)) ?? join(aOwn.tmp, 'secret')

  // B's session by uid, as A's: the one session process of a pool uid other than A's (only A and B run now). Its working
  // folder can't be the match: root reads another uid's /proc/<pid>/cwd only with CAP_SYS_PTRACE.
  const poolUids = new Set(pool.map((u) => u.uid))
  let bSession: Proc | undefined
  const findB = () => (bSession ??= procs().find((p) => poolUids.has(p.uid) && p.uid !== holder.uid && /session\/main\.mjs|probes\/direct\.mjs/.test(p.cmdline)))
  const split = (t: string) => [t.slice(0, 20), t.slice(20)]
  const filesProbes = (): ShellProbe[] => [
    { name: 'ls-work', cmd: 'ls -la /work' },
    { name: 'ls-users', cmd: `ls -la ${USERS_ROOT} ${aOwn.dir}` },
    { name: 'ls-a', cmd: `ls ${wa}/inputs ${aOwn.home} ${aOwn.tmp} ${wa}` },
    { name: 'cat-a-file', cmd: `cat ${wa}/inputs/secret.txt` },
    { name: 'cat-a-tmpdir', cmd: `cat ${aOwn.tmp}/secret ${aOwn.tmp}/*/secret` },
    { name: 'cat-a-home', cmd: `cat ${aOwn.home}/secret` },
    { name: 'cat-a-tmp', cmd: 'cat /tmp/iso-a-secret' },
    { name: 'grep-shared', cmd: `grep -rs 'CANARY.A' /tmp /var/tmp /dev/shm /run/lock` },
    { name: 'proc-holder', cmd: `tr '\\0' ' ' < /proc/${holder.pid}/cmdline; tr '\\0' ' ' < /proc/${holder.pid}/environ` },
    { name: 'proc-a-session', cmd: `tr '\\0' ' ' < /proc/${aSession?.pid}/environ; tr '\\0' ' ' < /proc/${aSession?.pid}/cmdline` },
    // Match the full markers, spelling each with a character class so the pattern in B's own argv doesn't match.
    { name: 'proc-all', cmd: `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; tr '\\0' ' ' < $p/environ; done 2>/dev/null | grep -oE 'CANAR[Y]_A_ENVIRON|canar[y]-A-cmdline-holder' | sort -u && echo scanned-$((40+2))` },
    { name: 'ps', cmd: 'ps -eo pid,user,args --no-headers | head -30' },
  ]
  // B's searches from a parent folder and through a link, by step: 13 Grep /users, 14 Grep / (files named *secret*
  // only: the probe's own bundle holds the canary strings), 15 Glob /users, 16 Bash makes the link, 17 Read the link.
  const wb = sessionPaths('p-iso-b').workDir
  const walkSteps = (wd: string) => [
    () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path: USERS_ROOT, output_mode: 'content' } }),
    () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path: '/', glob: '*secret*', output_mode: 'content' } }),
    () => ({ tool: 'Glob', input: { pattern: '**/*secret*', path: USERS_ROOT } }),
    bash(`ln -s ${aOpen} link-a && ls -l link-a`),
    () => ({ tool: 'Read', input: { file_path: join(wd, 'link-a') } }),
  ]
  const procGrep = () => ({ tool: 'Grep', input: { pattern: 'CANARY.A|^Uid:', path: '/proc', glob: 'status', output_mode: 'files_with_matches' } })
  // The same Grep on an ordinary folder: the control session's Grep works, so an empty /proc is the tool's own.
  const etcGrep = () => ({ tool: 'Grep', input: { pattern: '^root:', path: '/etc', glob: 'passwd', output_mode: 'files_with_matches' } })
  const [a1, a2] = split(a.run.token)
  const tokenProbes = (b: string): ShellProbe[] => {
    const [b1, b2] = split(b)
    return [
      {
        name: 'token',
        cmd:
          `printf '%s' '${a1}' > "$TMPDIR/pat"; printf '%s\\n' '${a2}' >> "$TMPDIR/pat"; printf '%s' '${b1}' >> "$TMPDIR/pat"; printf '%s\\n' '${b2}' >> "$TMPDIR/pat"; ` +
          `env | grep -F -f "$TMPDIR/pat"; grep -rlsF --exclude=pat -f "$TMPDIR/pat" /proc/[0-9]*/environ /proc/[0-9]*/cmdline . "$HOME" /tmp /var/tmp /dev/shm /etc /run 2>/dev/null | head; echo searched`,
      },
      {
        // The channel is fd 3 (session -> root) and fd 4 (root -> session) of each session process: B's own and A's,
        // through /proc (the process's command line, a link shown, or an open that works), and whether Bash itself
        // holds either fd.
        name: 'channel',
        cmd:
          `env | grep NODE_CHANNEL; for p in ${aSession?.pid ?? 'none'} ${findB()?.pid ?? 'none'}; do tr '\\0' ' ' < /proc/$p/cmdline; echo; for f in 3 4; do readlink /proc/$p/fd/$f; ` +
          `( exec 9<>/proc/$p/fd/$f ) 2>/dev/null && echo "OPEN$f"; done; done 2>&1; for f in 3 4; do readlink /proc/$$/fd/$f; done; echo checked`,
      },
    ]
  }
  let tokenScript = ''
  const b = startRun({
    chatId: 'p-iso-b',
    script: {
      steps: [
        bash(shellScript(filesProbes())),
        () => ({ tool: 'Read', input: { file_path: `${wa}/inputs/secret.txt` } }),
        () => ({ tool: 'Read', input: { file_path: '/tmp/iso-a-secret' } }),
        () => ({ tool: 'Read', input: { file_path: `/proc/${holder.pid}/cmdline` } }),
        () => ({ tool: 'Read', input: { file_path: `/proc/${holder.pid}/environ` } }),
        () => ({ tool: 'Read', input: { file_path: aTmpSecret() } }),
        () => ({ tool: 'Read', input: { file_path: `${aOwn.home}/secret` } }),
        () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path: '/tmp', output_mode: 'content' } }),
        () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path: '/work', output_mode: 'content' } }),
        () => ({ tool: 'Glob', input: { pattern: '**/*', path: wa } }),
        () => {
          findB()
          tokenScript = shellScript(tokenProbes(b.run.token))
          return bash(tokenScript)()
        },
        () => ({ tool: 'Read', input: { file_path: aOpen } }),
        () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path: aOwn.tmp, output_mode: 'content' } }),
        // From a parent folder and through a link: the rules name A's folders, not the search root or the link.
        ...walkSteps(wb),
        // /proc from its root. Only the status files: a whole /proc walk reads the uid's own pagemaps (huge).
        procGrep,
      ],
    },
  })
  const rb = await b.done
  const canary = (t: string) => /CANARY_A|canary-A-cmdline/.test(t)
  const files = filesProbes()
  // Guard off: root reads the same, while A is still up (its release empties its home and temp folder).
  const off = await rootShell(shellScript(files))
  // The off scan must see a real marker while A's holder is up. A's own uid can also read its proc entries without
  // Docker root needing CAP_SYS_PTRACE.
  const procOff = (await userShell(aUser, shellScript(files.filter((p) => p.name === 'proc-all')))).get('proc-all')
  // The proc probes' control: A's own uid, outside the sandbox's PID namespace, reads the same entries.
  const procOffA = await userShell(aUser, shellScript(files.filter((p) => p.name === 'proc-holder' || p.name === 'proc-a-session')))
  // The channel, outside the sandbox's PID namespace, as a plain process of each uid: A's own uid sees both of its
  // session's channel fds; B's uid is refused them (the uid wall, with no namespace in the way).
  const fdView = (u: { uid: number; gid: number }) =>
    aSession ? runCommand('python3', ['-c', FD_VIEW, String(aSession.pid)], { uid: u.uid, gid: u.gid }) : Promise.resolve({ code: null, out: "A's session not found" })
  const chOff = await fdView(aUser)
  // B's run has ended and the root is releasing its uid: the release kills every process of the uid, so a process of
  // B's uid starts only once the release is done (its event, not a timer). A's session is still up.
  const bRelease = await releaseOf(rb)
  const bUser = bSession && pool.find((u) => u.uid === bSession!.uid)
  const chB = !bUser ? { code: null, out: "B's session not found" } : bRelease.ok ? await fdView(bUser) : { code: null, out: `B's uid is not free: ${bRelease.detail}` }
  // Outside the namespace, root saw both sessions by their command lines: procs() read each while it was up (B's when
  // its Bash was about to look). B's session is gone by now, so /proc can't be read for it again.
  const sessionsSeen = [aSession, bSession].map((p) => p?.cmdline ?? '')
  // The Read tool's rules, each taken out alone in a direct session while A is up: what its other walls do.
  const readStep = (file_path: string) => () => ({ tool: 'Read', input: { file_path } })
  const grepStep = (path: string) => () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path, output_mode: 'content' } })
  const ruleOff = async (variant: 'tmp-rule-off' | 'proc-rule-off' | 'users-rule-off', steps: (() => { tool: string; input: Record<string, unknown> })[]) => {
    const d = await direct(variant, { prompt: 'Run the probe.', webFetchDomains: [] }, { steps })
    return steps.map((_, i) => d.state.results.get(d.state.ids[i]!)?.text ?? `no result (${d.cleanup || d.raw.slice(-200)})`)
  }
  const [tmpRead, tmpGrep] = await ruleOff('tmp-rule-off', [readStep('/tmp/iso-a-secret'), grepStep('/tmp')])
  const [procCmd, procEnv, procGrepOff, etcGrepOff] = await ruleOff('proc-rule-off', [readStep(`/proc/${holder.pid}/cmdline`), readStep(`/proc/${holder.pid}/environ`), procGrep, etcGrep])
  const [usersRead, usersGrep, usersHome, usersTmpdir, ...usersWalk] = await ruleOff('users-rule-off', [
    readStep(aOpen),
    grepStep(aOwn.tmp),
    readStep(`${aOwn.home}/secret`),
    readStep(aTmpSecret()),
    ...walkSteps(sessionPaths(`p-direct-users-rule-off`).workDir),
  ])
  const offReadable = [`${wa}/inputs/secret.txt`, aTmpSecret(), `${aOwn.home}/secret`].every((p) => existsSync(p) && canary(readFileSync(p, 'utf8')))
  // The /tmp canary is A's uid's, written from outside the sandbox: A's own Bash can't write /tmp, so what B's Bash
  // reads of it says nothing about a wall A could get past. Printed as facts.
  const observeOnly = ['ls-work', 'ls-users', 'ps', 'proc-holder', 'proc-a-session', 'proc-all', 'cat-a-tmp', 'grep-shared']
  // A's process ends once the probe is done (a condition, not a timer).
  appendFileSync(join(wa, 'outputs', '.go'), '')
  const ra = await a.done
  checkRun('isolation.a', ra, [0])
  checkRun('isolation.b', rb, [0, 10, 16])
  fact('isolation.a-wrote', ra.state.results.get(ra.state.ids[0]!)?.text.slice(0, 300) ?? '')
  // A's release: the canaries were readable before release; now neither folder may contain anything at all.
  const aRelease = await releaseOf(ra)
  const aLeft = await runCommand('find', [aOwn.home, aOwn.tmp, '-mindepth', '1'])
  record(
    'isolation.a.own-folders-emptied-at-release',
    offReadable && aRelease.ok && aRelease.uid === aUser.uid && aLeft.code === 0 && aLeft.out.trim() === '',
    `${aRelease.detail}; expected uid ${aUser.uid}, canaries seeded: ${offReadable}; find status ${aLeft.code}, left: ${aLeft.out.trim().slice(0, 300) || 'nothing'}`,
  )

  const real = parseShell(result(rb, 0)?.text ?? '')
  judge(
    'isolation.bash',
    real,
    off,
    files.map((p) =>
      observeOnly.includes(p.name) ? { name: p.name } : { name: p.name, leak: (x: ShellResult) => canary(x.out) || (p.name === 'ls-a' && x.out.includes('secret.txt')) },
    ),
  )
  rmSync('/tmp/iso-a-secret', { force: true })
  // A's session holds no canary of its own: its marker is its command line and HOME.
  const sessionMark = (t: string) => t.includes('session/main.mjs') || t.includes(`HOME=${aOwn.home}`)
  // The holder's control must show both of its markers: the command line and the environ canary.
  const holderMarks = (t: string) => canary(t) && t.includes('CANARY_A_ENVIRON')
  for (const [n, leak, offLeak] of [
    ['proc-holder', canary, holderMarks],
    ['proc-a-session', sessionMark, sessionMark],
  ] as const) {
    const x = real.get(n)
    const o = procOffA.get(n)
    const seenOff = o !== undefined && offLeak(o.out)
    record(
      `isolation.bash.${n}-no-canary`,
      x !== undefined && !leak(x.out) && seenOff,
      `agent: ${x?.out.slice(0, 200) ?? 'no output'} | guard off (A's uid, outside the PID namespace): ${seenOff ? 'seen' : `NOT SEEN: ${o?.out.slice(0, 120)}`}`,
    )
  }
  const procAll = real.get('proc-all')
  const scanned = (x: ShellResult | undefined) => x?.rc === 0 && x.out.split('\n').includes('scanned-42')
  const procSeenOff = scanned(procOff) && canary(procOff?.out ?? '')
  record(
    'isolation.bash.proc-all-no-canary',
    scanned(procAll) && !canary(procAll?.out ?? '') && procSeenOff,
    `agent: ${procAll?.out ?? 'no output'} | guard off (A's uid): ${procOff?.out ?? 'no output'}`,
  )
  const tools = ['read-a-file', 'read-a-tmp', 'read-a-holder-cmdline', 'read-a-holder-environ', 'read-a-tmpdir', 'read-a-home', 'grep-tmp', 'grep-work', 'glob-a']
  // The probes a permission rule guards: their control is a direct session with only that rule taken out.
  const ruleControls: Record<string, { rule: string; text: string }> = {
    'read-a-tmp': { rule: 'Read(//tmp/**)', text: tmpRead! },
    'grep-tmp': { rule: 'Read(//tmp/**)', text: tmpGrep! },
    'read-a-holder-cmdline': { rule: 'Read(//proc/**)', text: procCmd! },
  }
  tools.forEach((n, i) => {
    const t = result(rb, i + 1)
    const leak = t !== undefined && (canary(t.text) || (n === 'glob-a' && t.text.includes('secret.txt')))
    const rc = ruleControls[n]
    // The Read tool may not read /proc entries at all: then the rule has nothing to stop, and the control can't show one.
    // Unproven only on the CLI's own refusal to read such a file; any other control result (none, a crash) fails.
    const procUnreadable = (text: string) => n.startsWith('read-a-holder') && /names a device or process file that this tool does not read/.test(text)
    if (rc) {
      const seenOff = canary(rc.text)
      const detail = `agent: ${t?.text.slice(0, 160)} | guard off (${rc.rule} taken out): ${seenOff ? 'leak seen' : `NOT SEEN: ${rc.text.slice(0, 120)}`}`
      if (t !== undefined && !leak && procUnreadable(rc.text)) markUnproven(`isolation.tool.${n}`, `the Read tool reads nothing there even with the rule out; ${detail}`)
      else record(`isolation.tool.${n}`, t !== undefined && !leak && seenOff, detail)
    } else if (n === 'read-a-holder-environ' && t !== undefined && !leak && procUnreadable(procEnv!)) {
      markUnproven(`isolation.tool.${n}`, `the Read tool reads nothing there even with Read(//proc/**) out: ${procEnv!.slice(0, 120)}`)
    } else if (n === 'read-a-holder-environ') {
      // Two walls: the rule refuses it first; with the rule out, the uid wall (environ is the owner's, behind ptrace
      // checks) still does. The detector is proven by A's own uid reading the canary.
      const ownerSees = holderMarks(procOffA.get('proc-holder')?.out ?? '')
      const wall = canary(procEnv!) ? 'NONE: the rule alone holds' : /EACCES|permission denied/i.test(procEnv!) ? 'the uid wall (EACCES)' : `unclear: ${procEnv!.slice(0, 100)}`
      record(
        `isolation.tool.${n}`,
        t !== undefined && !leak && ownerSees && !wall.startsWith('unclear'),
        `agent: ${t?.text.slice(0, 160)} | Read(//proc/**) taken out: ${wall} | A's own uid: ${ownerSees ? 'reads the canary' : 'NO CANARY SEEN'}`,
      )
    } else if (n === 'read-a-home' || n === 'read-a-tmpdir') {
      // Two walls: the per-user rule refuses it first; with the rule out, the uid wall (A's files are 0600) still does.
      // The detector is proven by root reading the canary.
      const ro = n === 'read-a-home' ? usersHome! : usersTmpdir!
      const wall = canary(ro) ? 'NONE: the rule alone holds' : /EACCES|permission denied/i.test(ro) ? 'the uid wall (EACCES)' : `unclear: ${ro.slice(0, 100)}`
      record(
        `isolation.tool.${n}`,
        t !== undefined && !leak && offReadable && !wall.startsWith('unclear'),
        `agent: ${t?.text.slice(0, 160)} | Read(//users/<other>/**) taken out: ${wall} | root reads A's files: ${offReadable ? 'leak seen' : 'NO LEAK SEEN'}`,
      )
    } else record(`isolation.tool.${n}`, t !== undefined && !leak && offReadable, `agent: ${t?.text.slice(0, 200)} | guard off (root reads A's files): ${offReadable ? 'leak seen' : 'NO LEAK SEEN'}`)
  })
  // A's temp folder opened by A itself: the per-user Read rules alone keep B's tools out.
  const opened = canary(openByMode.out)
  for (const [n, step, control] of [
    ['read-a-opened-tmp', 11, usersRead!],
    ['grep-a-opened-tmp', 12, usersGrep!],
  ] as const) {
    const t = result(rb, step)
    const seenOff = canary(control)
    record(
      `isolation.tool.${n}`,
      t !== undefined && !canary(t.text) && opened && seenOff,
      `agent: ${t?.text.slice(0, 160)} | modes open to every uid: ${opened} | guard off (Read(//users/<other>/**) taken out): ${seenOff ? 'leak seen' : `NOT SEEN: ${control.slice(0, 120)}`}`,
    )
  }
  // From a parent folder, through a link, and /proc from its root: each control is the same call with the rule out.
  fact('isolation.tool.link-made', `${result(rb, 16)?.text.replace(/\s+/g, ' ').slice(0, 200)} | rule off: ${usersWalk[3]?.replace(/\s+/g, ' ').slice(0, 200)}`)
  const globLeak = (t: string) => new RegExp(`${aOwn.dir}/(home|tmp)/\\S*secret`).test(t)
  const procLeak = (t: string) => canary(t) || /\/proc\/\d+\/status/.test(t)
  for (const [n, step, control, rule, leakOf] of [
    ['grep-users-root', 13, usersWalk[0]!, 'Read(//users/<other>/**)', canary],
    ['grep-fs-root', 14, usersWalk[1]!, 'Read(//users/<other>/**)', canary],
    ['glob-users-root', 15, usersWalk[2]!, 'Read(//users/<other>/**)', globLeak],
    ['read-symlink-to-a', 17, usersWalk[4]!, 'Read(//users/<other>/**)', canary],
    ['grep-proc-root', 18, procGrepOff!, 'Read(//proc/**)', procLeak],
  ] as const) {
    const t = result(rb, step)
    const seenOff = leakOf(control)
    // Grep finds nothing under /proc even with the rule out (CI, 04b4528 and 0b44c16), while the same Grep finds
    // /etc/passwd: the rule has nothing to stop there, and no control can show one. Unproven; a leak still fails.
    if (n === 'grep-proc-root' && t !== undefined && !leakOf(t.text) && control.trim() === 'No files found' && etcGrepOff!.includes('/etc/passwd')) {
      markUnproven(`isolation.tool.${n}`, `Grep finds nothing under /proc even with Read(//proc/**) out, and finds /etc/passwd the same way; agent: ${t.text.replace(/\s+/g, ' ').slice(0, 120)}`)
      continue
    }
    record(
      `isolation.tool.${n}`,
      t !== undefined && !leakOf(t.text) && seenOff,
      `agent: ${t?.text.replace(/\s+/g, ' ').slice(0, 200)} | guard off (${rule} taken out): ${seenOff ? 'leak seen' : `NOT SEEN: ${control.replace(/\s+/g, ' ').slice(0, 160)}`}`,
    )
  }

  const tok = parseShell(result(rb, 10)?.text ?? '')
  if (rb.via === 'direct') {
    record('token.not-reachable', false, 'needs the root path (the token lives only in the root): sessions through the root crash, see root.session-starts')
    record('channel.not-reachable', false, "needs the root path (the session's channel on fds 3 and 4): see root.session-starts")
    fact('token.direct-view', tok.get('token')?.out ?? 'no output')
    return
  }
  mkdirSync('/tmp/probe-tok-cwd', { recursive: true })
  const tokenText = tok.get('token')?.out ?? ''
  const tokenLeak = (t: string) => t.split('\n').some((l) => l !== 'searched' && l.trim() !== '')
  const tokenOff = await rootShell(tokenScript.replace(/"\$TMPDIR/g, '"/tmp/probe-tok-cwd').replace('/proc/[0-9]*/environ', '/proc/self/environ /proc/[0-9]*/environ'), { LEAKED: a.run.token }, '/tmp/probe-tok-cwd')
  record('token.not-reachable', tok.has('token') && !tokenLeak(tokenText) && tokenLeak(tokenOff.get('token')?.out ?? ''), `agent: ${tokenText.slice(0, 300)} | guard off (root, token in its env): ${tokenLeak(tokenOff.get('token')?.out ?? '') ? 'leak seen' : 'NO LEAK SEEN'}`)
  rmSync('/tmp/probe-tok-cwd', { recursive: true, force: true })
  const ch = tok.get('channel')
  fact('channel.bash-view', ch?.out ?? 'no output')
  fact('channel.sessions', `A ${aSession?.pid} uid ${aSession?.uid}, B ${bSession?.pid} uid ${bSession?.uid}`)
  const both = aSession !== undefined && bSession !== undefined && bSession.uid !== aSession.uid
  // (a) The PID namespace: from B's Bash neither session process is there at all (no command line, no fds), nor does
  // Bash hold a channel fd itself. Control: outside the namespace, both sessions' command lines.
  const chLeak = (t: string) => /session\/main\.mjs|(socket|pipe):\[|OPEN[34]|NODE_CHANNEL_FD=/.test(t)
  const nsOffSeen = sessionsSeen.every((c) => c.includes('session/main.mjs'))
  record(
    'channel.pid-namespace-hides-sessions',
    both && ch !== undefined && ch.out.includes('checked') && !chLeak(ch.out) && nsOffSeen && rb.events.every((e) => !(e.type === 'failed' && e.reason === 'protocol')),
    `agent: ${ch?.out.replace(/\n/g, ' ').slice(0, 300)}, run end ${JSON.stringify(terminalOf(rb))?.slice(0, 120)} | outside the namespace (root): ${nsOffSeen ? "both sessions' command lines seen" : `NOT SEEN: ${JSON.stringify(sessionsSeen).slice(0, 160)}`}`,
  )
  // (b) The uid wall, with no namespace in the way: B's uid, as a plain process in the container's namespace, is refused
  // A's fds 3 and 4 (EACCES); A's own uid, the control, sees both.
  const linked = (t: string) => t.split('\n').filter((l) => /^[34] (socket|pipe):\[/.test(l)).length
  const bRefused = /^3 EACCES$/m.test(chB.out) && /^4 EACCES$/m.test(chB.out) && linked(chB.out) === 0 && !/OPEN/.test(chB.out)
  record(
    'channel.uid-wall',
    both && bRefused && linked(chOff.out) === 2,
    `B's uid: ${chB.out.replace(/\n/g, ' ').slice(0, 160)} | A's uid (control): ${linked(chOff.out) === 2 ? 'both seen' : `NOT SEEN: ${chOff.out.replace(/\n/g, ' ').slice(0, 120)}`}`,
  )
  fact('umask.in-agent-bash', `A's files: ${ra.state.results.get(ra.state.ids[0]!)?.text.split('\n')[0] ?? ''}`)
}

async function probeProcessLimit() {
  const py = `python3 -c 'import os, errno
r, w = os.pipe()
n = 0; err = ""
while n < 1500:
    try:
        pid = os.fork()
    except OSError as e:
        err = errno.errorcode.get(e.errno, str(e.errno)); break
    if pid == 0:
        os.close(w); os.read(r, 1); os._exit(0)
    n += 1
print("FORKED", n, err, flush=True)
os.close(w)
for _ in range(n): os.wait()
'`
  const before = (await health())?.quarantinedUsers ?? -1
  const r = await startRun({ chatId: 'p-nproc', script: { steps: [bash(py)] } }).done
  checkRun('process-limit', r, [0])
  const forked = (t: string) => Number(/FORKED (\d+)/.exec(t)?.[1] ?? -1)
  const n = forked(result(r, 0)?.text ?? '')
  const off = await runCommand('bash', ['-c', py], { uid: userNamed('s48').uid, gid: userNamed('s48').gid, cwd: '/tmp' })
  const nOff = forked(off.out)
  record('process-limit.fork-bomb-stops', n >= 0 && n < SESSION_PROCESS_LIMIT && nOff === 1500, `agent forked ${n} (${result(r, 0)?.text.trim().slice(0, 80)}), limit ${SESSION_PROCESS_LIMIT} | guard off (no wrapper): forked ${nOff}`)
  // The release after the bomb: no uid quarantined, and the chat runs again.
  const release = await releaseOf(r)
  const again = await startRun({ chatId: 'p-nproc', script: { steps: [] } }).done
  const againRelease = await releaseOf(again)
  const after = (await health())?.quarantinedUsers ?? -1
  record(
    'process-limit.release-still-passes',
    before >= 0 && before === after && release.ok && againRelease.ok && terminalOf(again)?.type === 'finished',
    `${release.detail}; quarantined before ${before}, after ${after}; next run ${JSON.stringify(terminalOf(again))?.slice(0, 120)} (${againRelease.detail})`,
  )
}

/** A direct session as a pool user, with one test-only variant of the guarded options (direct.ts). */
const directUsers: Record<DirectVariant, string> = {
  plain: 's38',
  'four-tools': 's40',
  'audit-refused': 's41',
  'audit-hook-removed': 's42',
  'ip-allow': 's43',
  'ip-deny': 's44',
  'strict-on': 's45',
  'strict-off': 's46',
  'skills-not-off': 's47',
  'skills-open': 's58',
  'plugins-not-off': 's59',
  'home-skill-guarded': 's60',
  'home-skill-open': 's61',
  'home-skill-sources-open': 's37',
  'home-skill-skills-open': 's51',
  'tmp-rule-off': 's62',
  'proc-rule-off': 's63',
  'users-rule-off': 's35',
}
/** Agent runs' pool users while they go direct: one per chat, from s20 up (the root hands out s00 up). */
const agentUsers = new Map<string, PoolUser>()
const agentUser = (chatId: string) => {
  if (!agentUsers.has(chatId)) agentUsers.set(chatId, userNamed(`s${20 + agentUsers.size}`))
  return agentUsers.get(chatId)!
}

async function direct(variant: DirectVariant, input: Omit<DirectInput, 'variant'>, script: Script) {
  const state = newScript(script)
  const d = await spawnDirect(`p-direct-${variant}`, userNamed(directUsers[variant]), variant, input, state)
  return { ...d, state }
}

/** One direct session in a host-prepared folder; afterwards its uid is killed, its folder parked and its files wiped. */
async function spawnDirect(key: string, user: PoolUser, variant: DirectVariant, input: Omit<DirectInput, 'variant'>, state: ScriptState) {
  const script = state.script
  await host.killAll(user)
  await host.wipeUserFiles(user)
  const { workDir, home } = await host.prepareFolder(key, user)
  egress.byDirect.set(key, state)
  const env = { ...sessionEnv({ uid: user.uid, gid: user.gid, user: user.user, home, workDir }, 8081), ANTHROPIC_BASE_URL: `http://127.0.0.1:${egress.port}/direct/${key}/model`, PROBE_DIRECT: JSON.stringify({ variant, ...input }) }
  const out = await runCommand('node', ['--disable-sigusr1', `${PROBES}/direct.mjs`], { uid: user.uid, gid: user.gid, cwd: workDir, env, timeoutMs: 180_000 })
  const lines = out.out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  let cleanup = ''
  try {
    await host.killAll(user)
    await host.parkFolder(key)
    await host.wipeUserFiles(user)
  } catch (e) {
    cleanup = String(e instanceof Error ? e.message : e)
  }
  if (!lines.some((l) => l.type === 'result') || script.steps.some((_, i) => !state.results.has(state.ids[i]!))) {
    fact(`direct.${variant}.output`, `exit ${out.code}, model requests ${state.requests.length}, misses ${JSON.stringify(state.misses)}: ${out.out.slice(-1500)}`)
  }
  return { lines, raw: out.out, workDir, cleanup }
}

async function probeDirect() {
  // The four tools, with canUseTool and a stub inhouse server that has a resource.
  const four = await direct('four-tools', { prompt: 'Say hi.', webFetchDomains: [], mcpProxyUrl: `http://127.0.0.1:${egress.port}` }, { steps: [] })
  const init = four.lines.find((l) => l.type === 'init') as { tools: string[]; mcp_servers: unknown } | undefined
  if (init) {
    const outside = init.tools.map((t) => TOOL_ALIASES[t] ?? t).filter((t) => !(BUILT_IN_TOOLS as readonly string[]).includes(t) && !t.startsWith(`mcp__${INHOUSE_MCP_SERVER}__`))
    for (const t of ['AskUserQuestion', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'WaitForMcpServers']) fact(`four-tools.${t}`, init.tools.includes(t) ? 'registers' : 'does not register')
    fact('four-tools.all', `${JSON.stringify(init.tools)} servers ${JSON.stringify(init.mcp_servers)} mcp calls ${JSON.stringify(egress.mcpCalls)}`)
    record('four-tools.nothing-outside-the-20', outside.length === 0, `outside: ${JSON.stringify(outside)}`)
  } else record('four-tools.init', false, four.raw.slice(-600))

  // The blocking audit hook: a refused entry blocks the call; without the hook the same call goes through.
  const touch = { steps: [bash('touch outputs/audit-marker && echo touched')] }
  const refused = await direct('audit-refused', { prompt: 'Run the probe.', webFetchDomains: [] }, touch)
  const removed = await direct('audit-hook-removed', { prompt: 'Run the probe.', webFetchDomains: [] }, touch)
  const marker = (wd: string) => existsSync(join(wd, 'outputs', 'audit-marker'))
  record('audit.refused-entry-blocks-the-call', !marker(refused.workDir) && marker(removed.workDir), `with the hook: ${marker(refused.workDir) ? 'RAN' : 'blocked'} (${refused.state.results.get(refused.state.ids[0]!)?.text.slice(0, 150)}) | hook removed: ${marker(removed.workDir) ? 'ran (leak seen)' : 'NOT RUN: the probe cannot detect this'}`)

  // deniedDomains with an IP literal: sent through the proxy, where the lists decide.
  const curl = { steps: [bash(get(GW_URL, 'proxy'))] }
  const allow = await direct('ip-allow', { prompt: 'Run the probe.', webFetchDomains: [], ip: GW }, curl)
  const deny = await direct('ip-deny', { prompt: 'Run the probe.', webFetchDomains: [], ip: GW }, curl)
  const got = (d: { state: ScriptState }) => d.state.results.get(d.state.ids[0]!)?.text ?? ''
  fact('deniedDomains.ip-literal', `allowed only: ${got(allow).slice(0, 120)} | allowed and denied: ${got(deny).slice(0, 120)}`)
  record('deniedDomains.ip-literal-honoured', got(allow).includes(GW_OK) && !got(deny).includes(GW_OK), 'an IP literal in allowedDomains connects; the same in deniedDomains is refused')

  // strictAllowlist through the SDK's sandbox option.
  const on = await direct('strict-on', { prompt: 'Run the probe.', webFetchDomains: [] }, curl)
  const offRun = await direct('strict-off', { prompt: 'Run the probe.', webFetchDomains: [] }, curl)
  const asks = (d: { lines: Record<string, unknown>[] }) => JSON.stringify(d.lines.filter((l) => l.type === 'ask').map((l) => l.tool))
  fact('strictAllowlist', `on: ${got(on).slice(0, 120)} asks ${asks(on)} | off: ${got(offRun).slice(0, 120)} asks ${asks(offRun)}`)
  const offSeen = got(offRun).includes(GW_OK) || asks(offRun) !== '[]'
  record(
    'strictAllowlist.unlisted-refused-without-asking',
    !got(on).includes(GW_OK) && asks(on) === '[]' && offSeen,
    `on: ${got(on).slice(0, 120)} asks ${asks(on)} | off: ${offSeen ? `${got(offRun).includes(GW_OK) ? 'connected' : 'did not connect'}, asks ${asks(offRun)}` : 'NEITHER CONNECTED NOR ASKED: the probe cannot detect this'}`,
  )
}

/** Starts a helper as the user and waits for its first line. */
async function held(u: PoolUser, args: string[]): Promise<{ child: ChildProcess; line: string; end: () => Promise<void> }> {
  const child = spawn('python3', [`${PROBES}/sysv.py`, ...args], { uid: u.uid, gid: u.gid, cwd: '/tmp', env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d))
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (out += d))
  const line = await waitUntil(() => out.includes('\n') && out.split('\n')[0], `${args[0]} as ${u.user}`, 15_000, 20)
  return {
    child,
    line,
    end: () =>
      new Promise((r) => {
        if (child.exitCode !== null) return r()
        child.on('exit', () => r())
        child.stdin!.end()
      }),
  }
}
const sysv = (u: PoolUser, ...args: string[]) => runCommand('python3', [`${PROBES}/sysv.py`, ...args], { uid: u.uid, gid: u.gid, cwd: '/tmp' }).then((r) => r.out.trim())
const wipe = (u: PoolUser) => host.wipeUserFiles(u).then(() => 'passed', (e: unknown) => `threw: ${String(e instanceof Error ? e.message : e)}`)
const shmRows = () => readFileSync('/proc/sysvipc/shm', 'utf8').split('\n').slice(1).filter((l) => l.trim() !== '')

/**
 * The inhouse server's 20 tools with the pinned SDK, wired as production wires them: a run through the root, its
 * `inhouse` server from baseOptions (the proxy URL in sessionEnv), served by the probe egress with the 20 tools (six
 * marked `anthropic/alwaysLoad`). The six must go to the model loaded at start; each of the fourteen must be deferred,
 * shown positively: sent with `defer_loading`, or found by a ToolSearch call the script makes; and the request must
 * carry the DeferredToolPlaceholder. Compared with literal lists.
 */
/**
 * Structured output with the pinned SDK through the root (R3 follow-up): the guards let the SDK's StructuredOutput tool
 * through only when the run asks for structured output. Asked: a valid answer arrives as `finished.structuredOutput`,
 * and answers that never match the schema end the run `failed structured_output`. Not asked: StructuredOutput isn't
 * among the tools at all, and a call to it doesn't produce structured output.
 * What `not-asked` proves: end to end, with no outputFormat, the tool is absent and no output comes back. What it
 * doesn't: that the guards' `tools` entry is what gates it (the SDK may add the tool only with outputFormat anyway);
 * that rule is pinned by test/guards/options.test.ts, not here.
 */
async function probeStructured() {
  if (VIA !== 'root') return record('structured.via-root', false, `runs go ${VIA}`)
  const schema = { type: 'object', properties: { late_orders: { type: 'integer' } }, required: ['late_orders'], additionalProperties: false }
  const outputFormat = { type: 'json_schema' as const, schema }
  const answer = (input: Record<string, unknown>) => () => ({ tool: 'StructuredOutput', input })

  const ok = startRun({ chatId: 'p-structured-ok', script: { steps: [answer({ late_orders: 3 })] }, outputFormat })
  await ok.done
  const okEnd = terminalOf(ok.run) as { type: string; structuredOutput?: unknown } | undefined
  record('structured.asked-answer', okEnd?.type === 'finished' && JSON.stringify(okEnd.structuredOutput) === '{"late_orders":3}', `end ${JSON.stringify(okEnd)?.slice(0, 300)}, misses ${JSON.stringify(ok.run.state.misses)}`)
  record('structured.asked-tool-present', initOf(ok.run)?.tools.includes('StructuredOutput') === true, `tools ${JSON.stringify(initOf(ok.run)?.tools)}`)

  const bad = startRun({ chatId: 'p-structured-bad', script: { steps: Array.from({ length: 12 }, () => answer({ late_orders: 'many' })) }, outputFormat })
  await bad.done
  const badEnd = terminalOf(bad.run)
  const badResult = sdkMessages(bad.run.events).find((m) => m.type === 'result') as { subtype?: string } | undefined
  fact('structured.retries', `the SDK's result subtype ${badResult?.subtype}, model requests ${bad.run.state.requests.length}`)
  record('structured.retries-fail', badEnd?.type === 'failed' && badEnd.reason === 'structured_output', `end ${JSON.stringify(badEnd)?.slice(0, 300)}`)

  const plain = startRun({ chatId: 'p-structured-plain', script: { steps: [answer({ late_orders: 3 })] } })
  await plain.done
  const plainEnd = terminalOf(plain.run) as { type: string; structuredOutput?: unknown } | undefined
  record('structured.not-asked-tool-absent', initOf(plain.run) !== undefined && !initOf(plain.run)!.tools.includes('StructuredOutput'), `tools ${JSON.stringify(initOf(plain.run)?.tools)}`)
  record('structured.not-asked-no-output', plainEnd !== undefined && plainEnd.structuredOutput === undefined, `end ${JSON.stringify(plainEnd)?.slice(0, 300)}; the call's result ${result(plain.run, 0)?.text.slice(0, 200)}`)
}

async function probeInhouseTools() {
  if (VIA !== 'root') return record('inhouse-tools.via-root', false, `runs go ${VIA}: the proxy-URL server needs the root`)
  const prefix = `mcp__${INHOUSE_MCP_SERVER}__`
  const search = () => ({ tool: 'ToolSearch', input: { query: `select:${INHOUSE_ON_DEMAND.map((n) => `${prefix}${n}`).join(',')}`, max_results: 20 } })
  const { run, done } = startRun({ chatId: 'p-inhouse-tools', script: { steps: [search], mcp20: true } })
  await done
  checkRun('inhouse-tools', run, [])
  const first = run.state.requests[0]
  if (!first) return record('inhouse-tools.first-request', false, `no model request: ${run.body.slice(-400)}`)
  const tools = (first.tools ?? []) as { name: string; defer_loading?: boolean }[]
  const loaded = tools.filter((t) => t.name.startsWith(prefix) && t.defer_loading !== true).map((t) => t.name.slice(prefix.length)).sort()
  const sentDeferred = tools.filter((t) => t.name.startsWith(prefix) && t.defer_loading === true).map((t) => t.name.slice(prefix.length))
  const found = result(run, 0)?.text ?? ''
  const viaSearch = INHOUSE_ON_DEMAND.filter((n) => found.includes(`${prefix}${n}`))
  const deferred = INHOUSE_ON_DEMAND.filter((n) => !loaded.includes(n) && (sentDeferred.includes(n) || viaSearch.includes(n)))
  fact('inhouse-tools.first-request', `loaded ${JSON.stringify(loaded)}, sent deferred ${JSON.stringify(sentDeferred)}, found by ToolSearch ${JSON.stringify(viaSearch)}, tool names ${JSON.stringify(tools.map((t) => t.name))}`)
  record('inhouse-tools.six-at-start', JSON.stringify(loaded) === JSON.stringify([...INHOUSE_ALWAYS].sort()), `loaded at start: ${JSON.stringify(loaded)}`)
  record('inhouse-tools.fourteen-deferred', deferred.length === INHOUSE_ON_DEMAND.length, `deferred and reachable: ${JSON.stringify(deferred)}; not: ${JSON.stringify(INHOUSE_ON_DEMAND.filter((n) => !deferred.includes(n)))}`)
  record('inhouse-tools.placeholder', tools.some((t) => t.name === 'DeferredToolPlaceholder'), `tool names ${JSON.stringify(tools.map((t) => t.name))}`)
}

async function probeSysV() {
  const [x, y, z] = [userNamed('s52'), userNamed('s53'), userNamed('s54')]
  // a: X makes Y the owner of a segment and stays attached: Y's wipe must still pass.
  const idA = await sysv(x, 'create', '0', '666')
  fact('sysv.give', await sysv(x, 'give', idA, String(y.uid)))
  const holdA = await held(x, ['hold', idA])
  const wipeY = await wipe(y)
  record('sysv.owner-named-by-another-session-does-not-fail-the-wipe', wipeY === 'passed', `Y's wipe ${wipeY}`)
  await holdA.end()
  await host.killAll(x)
  record('sysv.creator-wipe-after-detach', (await wipe(x)) === 'passed', 'X detached and released')

  // b: a mode 000 segment is gone after its creator's release.
  const idB = await sysv(x, 'create', '0', '000')
  const wipeB = await wipe(x)
  const still = shmRows().some((l) => l.trim().split(/\s+/)[1] === idB)
  record('sysv.mode-000-removed', /^\d+$/.test(idB) && wipeB === 'passed' && !still, `id ${idB}, wipe ${wipeB}, still listed ${still}`)

  // c: X's segment left attached in another live session quarantines X (its wipe throws), until the other detaches.
  const idC = await sysv(x, 'create', '0', '666')
  const holdC = await held(z, ['hold', idC])
  const wipeC = await wipe(x)
  record('sysv.left-attached-elsewhere-fails-the-creator-wipe', wipeC.startsWith('threw') && wipeC.includes('shm'), `X's wipe ${wipeC}`)
  await holdC.end()
  await host.killAll(z)
  record('sysv.after-the-other-detaches', (await wipe(x)) === 'passed' && (await wipe(z)) === 'passed', 'X and Z wiped')

  // d: two sessions and one fixed key.
  // shmget(key, 0, 0) asks for no permission, so it finds any key: attaching is what sharing takes.
  const closed = await sysv(x, 'create', '0x5150', '600')
  const otherClosed = await sysv(y, 'attach', '0x5150')
  const open = await sysv(x, 'create', '0x5151', '666')
  const otherOpen = await sysv(y, 'attach', '0x5151')
  fact('sysv.fixed-key', `0600 segment (id ${closed}): the other uid's attach ${otherClosed}; 0666 segment (id ${open}): the other uid's attach ${otherOpen}`)
  record('sysv.fixed-key-closed-not-shared', otherClosed.startsWith('ERR') && otherOpen.startsWith('ATTACHED'), `0600: ${otherClosed}; 0666 (shared by its creator's choice): ${otherOpen}`)
  record('sysv.cleanup', (await wipe(x)) === 'passed' && (await wipe(y)) === 'passed', 'X and Y wiped')
}

async function probeClosedFolder() {
  const [x, y] = [userNamed('s55'), userNamed('s56')]
  const dirs = ['/tmp/probe-closed', '/var/tmp/probe-closed']
  for (const d of dirs) {
    await runCommand('bash', ['-c', `mkdir -m 0777 ${d} && chmod 0777 ${d}`], { uid: y.uid, gid: y.gid })
    await runCommand('bash', ['-c', `echo left > ${d}/f`], { uid: x.uid, gid: x.gid })
    await runCommand('chmod', ['0700', d], { uid: y.uid, gid: y.gid })
  }
  const r = await wipe(x)
  record('wipe.finds-a-file-in-another-uids-closed-folder', r.includes('/tmp/probe-closed/f'), r)
  record('wipe.continues-past-a-failing-folder-and-reports-all', dirs.every((d) => r.includes(`${d}/f`)), r)
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  record('wipe.after-cleanup', (await wipe(x)) === 'passed' && (await wipe(y)) === 'passed', 'X and Y wiped')
}

async function probeZombieLeader() {
  const x = userNamed('s57')
  const h = await held(x, ['pthread-exit'])
  const pid = Number(h.line.split(' ')[1])
  const status = await waitUntil(() => {
    const e = parseStatus(pid, readFileSync(`/proc/${pid}/status`, 'utf8'))
    return e?.zombie ? e : null
  }, 'the leader to be a zombie', 15_000, 20)
  fact('zombie-leader', `pid ${pid}: zombie ${status.zombie}, threads ${status.threads}`)
  let killed = 'passed'
  await host.killAll(x).catch((e: unknown) => (killed = `threw: ${String(e)}`))
  const left = (await readProcs()).filter((p) => p.uids.includes(x.uid))
  record('zombie-leader.killed', status.threads > 1 && killed === 'passed' && left.length === 0, `threads ${status.threads}, killAll ${killed}, left ${left.length}`)
}

/**
 * What the sandbox needs from the platform, checked before any agent probe so one clear line says so when it's missing:
 * a session user's command inside bubblewrap must be able to make a user namespace that holds capabilities. The CLI's
 * seccomp helper does exactly that, for its own PID and mount namespace, and every sandboxed command dies without it
 * (`apply-seccomp: write /proc/self/setgroups ... Permission denied`). A host whose AppArmor has a profile for
 * /usr/bin/bwrap that strips capabilities from what bwrap runs (Ubuntu's bwrap-userns-restrict) takes it away, in a
 * container too: the profile attaches by path, and the label below then reads `bwrap//&unpriv_bwrap`. Then two Bash
 * calls in a row, as production runs them.
 */
async function probeSandboxPlatform() {
  const u = userNamed('s36')
  const asUser = (script: string) => runCommand('bash', ['-c', script], { uid: u.uid, gid: u.gid, cwd: '/tmp' }).then((r) => r.out.replace(/\s+/g, ' ').trim())
  fact('userns.as-session-user', await asUser('unshare -Ur sh -c "unshare -Ur true && echo nested-ok"; cat /proc/sys/user/max_user_namespaces; for f in /proc/sys/kernel/apparmor_restrict_unprivileged_*; do echo "$f=$(cat $f 2>&1)"; done'))
  const inBwrap = await asUser(`bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid -- sh -c 'echo "label=$(cat /proc/self/attr/current 2>&1)"; unshare -Ur true && echo nested-ok' 2>&1`)
  record('platform.nested-userns-inside-bwrap', inBwrap.includes('nested-ok'), inBwrap)

  // The markers are computed, so a refusal that quotes the command back doesn't read as a run.
  const d = await direct('plain', { prompt: 'Run the probe.', webFetchDomains: [] }, { steps: [bash('echo first-$((40 + 2)); touch "$TMPDIR/p" && echo tmp-writable'), bash('echo second-$((40 + 2))')] })
  const out = [0, 1].map((i) => d.state.results.get(d.state.ids[i]!)?.text.replace(/\s+/g, ' ').slice(0, 300) ?? 'no result')
  record('sandbox.bash-runs-twice', out[0]!.includes('first-42') && out[0]!.includes('tmp-writable') && out[1]!.includes('second-42'), `first: ${out[0]} | second: ${out[1]}`)
}

// ---------------------------------------------------------------------------------------------------------------------
// Main

async function step(name: string, fn: () => Promise<void>) {
  const t = Date.now()
  console.log(`--- ${name}`)
  try {
    await fn()
  } catch (e) {
    record(`${name}.ran`, false, String(e instanceof Error ? e.stack : e))
  }
  console.log(`--- ${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`)
}

if (!GW_PORT) throw new Error('PROBE_GW_PORT is not set')
fact('platform', `own ${OWN}, gateway ${GW}, kernel ${readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim()}`)
appendFileSync('/etc/hosts', `\n${GW} ${NAMES.gw}\n${OWN} ${NAMES.own}\n127.0.0.1 ${NAMES.loop}\n169.254.169.254 ${NAMES.meta}\n`)
await step('shared-writable', probeSharedWritable)
await startRoot()
await step('root-session', async () => {
  const r = await startRun({ chatId: 'p-canary', script: { steps: [bash('echo canary')] } }).done
  const t = terminalOf(r)
  if (t?.type === 'failed' && t.reason === 'session_crashed') await diagnoseSession()
  record('root.session-starts', t?.type === 'finished', `a session through the root's API: ${JSON.stringify(t)?.slice(0, 200)}`)
  if (t?.type !== 'finished') {
    VIA = 'direct'
    fact('agent-runs-via', 'direct sessions (same guards, sandbox, wrapper, pool user and folder layout; no root channel, proxy or token)')
  }
})
await step('sandbox-platform', probeSandboxPlatform)
await step('egress', probeEgress)
await step('no-unsandboxed-retry', probeNoUnsandboxedRetry)
await step('claude-dir', probeClaudeDir)
await step('facts', probeFacts)
await step('long-tmpdir', probeLongTmpdir)
await step('code-review', probeCodeReview)
await step('isolation', probeIsolation)
await step('process-limit', probeProcessLimit)
await step('direct', probeDirect)
await step('inhouse-tools', probeInhouseTools)
await step('structured', probeStructured)
await step('sysv', probeSysV)
await step('closed-folder', probeClosedFolder)
await step('zombie-leader', probeZombieLeader)

const h = await health()
record('root.still-healthy', h?.ok === true && h.live === 0 && h.quarantinedUsers === 0, JSON.stringify(h))
record('egress.no-unknown-token-calls', egress.refused.length === 0, JSON.stringify(egress.refused))
root!.kill('SIGTERM')
await waitUntil(() => root.exitCode !== null || root.signalCode !== null, 'the root to stop', 30_000)
await egress.close()

// The probes whose control can't be made on this CLI, each with its why in its FACT line. Any other UNPROVEN (a control
// that vanished, a new probe without one) fails the job.
const EXPECTED_UNPROVEN = ['isolation.tool.read-a-holder-cmdline', 'isolation.tool.read-a-holder-environ', 'isolation.tool.grep-proc-root']
const unproven = facts.filter((f) => f.value.startsWith('UNPROVEN'))
const unexpected = unproven.filter((f) => !EXPECTED_UNPROVEN.includes(f.name))
record('probes.unproven-only-the-expected', unexpected.length === 0, `unexpected: ${JSON.stringify(unexpected.map((f) => f.name))}, expected: ${JSON.stringify(EXPECTED_UNPROVEN)}`)
const failed = outcomes.filter((o) => !o.ok)
console.log(`\n${outcomes.length - failed.length} of ${outcomes.length} probes passed, ${facts.length} facts`)
if (unproven.length > 0) console.log(`UNPROVEN (not counted as passing): ${unproven.map((f) => f.name).join(', ')}`)
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`)
  console.log('--- root log (last 80 lines)')
  for (const l of rootLog.slice(-80)) console.log(l.slice(0, 400))
}
process.exit(failed.length === 0 ? 0 : 1)
