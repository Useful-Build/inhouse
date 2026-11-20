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
// Each probe fails loudly when its guard is missing: it is run once more with the guard off, in this script only (as
// root, unsandboxed, or a direct session with a test-only variant), and that run must show the leak. A probe whose
// detector can't see the leak with the guard off fails. Facts (what the kernel and the engine do) are printed as
// `FACT`; each probe as `PROBE PASS|FAIL`. Exit code 1 if any probe failed.
//
// The host's HTTP server (PROBE_GW_PORT, on the Docker bridge gateway) serves probe.txt with GW_OK: a private address
// outside the container that the sandbox's allowlist can name.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_HEADER, PROTOCOL_VERSION, type RunEvent } from '../../../shared/protocol/index.ts'
import { SHARED_WRITABLE, createSessionHost, parseStatus, readProcs } from '../../src/guards/host.ts'
import { ALLOWED_SKILLS, BUILT_IN_TOOLS, BUNDLED_SKILLS_OFF, INHOUSE_MCP_SERVER, PLUGIN_NAME } from '../../src/guards/lists.ts'
import { SESSION_PROCESS_LIMIT, sessionPaths } from '../../src/guards/paths.ts'
import { readPool, type PoolUser } from '../../src/guards/users.ts'
import { productionHostDeps } from '../../src/server/production.ts'
import { sessionEnv } from '../../src/session/env.ts'
import type { DirectInput, DirectVariant } from './direct.ts'
import {
  PROBE_MODEL,
  facts,
  newScript,
  outcomes,
  parseShell,
  record,
  fact,
  runCommand,
  shellScript,
  startEgress,
  waitUntil,
  type Script,
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
let root: ChildProcess

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
  const keep = (d: Buffer) => rootLog.push(...d.toString('utf8').split('\n').filter((l) => l.trim() !== ''))
  root.stdout!.on('data', keep)
  root.stderr!.on('data', keep)
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
const initOf = (r: Run): Init | undefined => {
  if (r.via === 'root') return sdkMessages(r.events).find((m) => m.type === 'system' && m.subtype === 'init') as Init | undefined
  const l = r.lines.find((x) => x.type === 'init') as (Omit<Init, 'plugins'> & { plugins: string[] }) | undefined
  return l && { ...l, plugins: l.plugins.map((name) => ({ name })) }
}
const terminalOf = (r: Run): { type: string; reason?: string } | undefined => {
  if (r.via === 'root') return r.events.findLast((e) => e.type === 'finished' || e.type === 'failed')
  const res = r.lines.find((x) => x.type === 'result')
  return res ? { type: 'finished' } : { type: 'failed', reason: 'session_crashed', ...(r.lines.find((x) => x.type === 'error') ?? {}) }
}

/** Starts one run through the root's API; `done` settles once its stream has ended. */
function startRun(opts: { chatId: string; script: Script; prompt?: string; webFetchDomains?: string[] }): { run: Run; done: Promise<Run> } {
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
        effort: 'low',
        maxTurns: 20,
        maxBudgetUsd: 1,
        runToken: token,
        webFetchDomains: opts.webFetchDomains ?? [],
        fileCaps: { maxFileBytes: 1_000_000, maxFilesPerTurn: 10, maxRestoreBytes: 1_000_000, allowedTypes: ['text/plain'] },
      }),
    })
    run.status = res.status
    const text = await res.text()
    run.body = text
    if (res.status === 200) for (const line of text.split('\n')) if (line.trim() !== '') run.events.push(JSON.parse(line) as RunEvent)
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
  const ok = r.status === 200 && t?.type === 'finished' && r.state.misses.length === 0 && missing.length === 0
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
    { name: 'allowlisted-name-to-private-address', cmd: `curl -sS -m 8 http://${NAMES.gw}:${GW_PORT}/probe.txt` },
    { name: 'unlisted-public-name', cmd: 'curl -sS -m 8 http://example.com/' },
    { name: 'ip-literal', cmd: `curl -sS -m 8 ${GW_URL}` },
    { name: 'no-proxy', cmd: `curl -sS -m 8 --noproxy '*' ${GW_URL}` },
    { name: 'dev-tcp', cmd: `exec 3<>/dev/tcp/${GW}/${GW_PORT} && printf 'GET /probe.txt HTTP/1.0\\r\\n\\r\\n' >&3 && cat <&3` },
    { name: 'python', cmd: `python3 -c 'import urllib.request;print(urllib.request.urlopen("${GW_URL}",timeout=8).read().decode())'` },
    { name: 'own-name-root-api', cmd: `curl -sS -m 8 http://${NAMES.own}:8080/health` },
    { name: 'own-address-root-api', cmd: `curl -sS -m 8 http://${OWN}:8080/health; curl -sS -m 8 --noproxy '*' http://${OWN}:8080/health` },
    { name: 'loopback-root-api', cmd: `curl -sS -m 8 http://127.0.0.1:8080/health; curl -sS -m 8 --noproxy '*' http://127.0.0.1:8080/health; curl -sS -m 8 http://localhost:8080/health; curl -sS -m 8 http://${NAMES.loop}:8080/health` },
    { name: 'root-proxy-8081', cmd: `curl -sS -m 8 http://127.0.0.1:8081/nope; curl -sS -m 8 --noproxy '*' http://127.0.0.1:8081/nope; curl -sS -m 8 http://${NAMES.loop}:8081/nope; curl -sS -m 8 http://${OWN}:8081/nope` },
    { name: 'metadata', cmd: `curl -sS -m 5 http://169.254.169.254/; curl -sS -m 5 http://${NAMES.meta}/` },
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
  if (existsSync(join(claude, 'x'))) leaks.push('.claude/x made')
  if (existsSync(join(claude, 'skills', 'evil'))) leaks.push('.claude/skills/evil made')
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
    { name: 'home-skill', cmd: `mkdir -p "$HOME/.claude/skills/evil" && printf -- '---\\nname: evil\\ndescription: probe\\n---\\nprobe\\n' > "$HOME/.claude/skills/evil/SKILL.md" && echo made` },
    { name: 'home-settings', cmd: `mkdir -p "$HOME/.claude" && printf '{"permissions":{"allow":["Bash"]}}' > "$HOME/.claude/settings.json" && echo made` },
  ]
  const script = shellScript(probes)
  const wd = sessionPaths('p-claude').workDir
  const { done } = startRun({
    chatId: 'p-claude',
    script: {
      steps: [bash(script), () => ({ tool: 'Write', input: { file_path: `${wd}/.claude/settings.json`, content: '{"x":1}' } }), () => ({ tool: 'Write', input: { file_path: `${wd}/.mcp.json`, content: '{"x":1}' } })],
    },
  })
  const r = await done
  checkRun('claude-dir', r, [0])
  judge('claude-dir', parseShell(result(r, 0)?.text ?? ''), null, probes.map((p) => ({ name: p.name })))
  fact('claude-dir.write-tool', `${result(r, 1)?.text.slice(0, 200)} | ${result(r, 2)?.text.slice(0, 200)}`)
  const leaks = claudeDirLeaks(wd)
  // Guard off: the same script as root in a folder the real host laid out the same way.
  const selfKey = 'p-claude-self'
  const self = await host.prepareFolder(selfKey, userNamed('s49'))
  await rootShell(script, { HOME: join(self.workDir, '.home') }, self.workDir)
  const offLeaks = claudeDirLeaks(self.workDir)
  rmSync('/opt/inhouse/plugin/x', { force: true })
  rmSync('/opt/runner/x', { force: true })
  await host.parkFolder(selfKey)
  record('claude-dir.not-writable', leaks.length === 0 && offLeaks.length >= 6, `agent: ${JSON.stringify(leaks)} | guard off (root, same layout): ${JSON.stringify(offLeaks)}`)

  // The home is the session's own and writable; what it writes there must not load: settingSources [] and the lists.
  const again = await startRun({ chatId: 'p-claude', script: { steps: [] } }).done
  const init = initOf(again)
  const loaded = [...(init?.skills ?? []), ...(init?.slash_commands ?? [])].filter((s) => s.includes('evil'))
  record('claude-dir.home-skill-not-loaded', init !== undefined && loaded.length === 0, `next run's skills ${JSON.stringify(init?.skills)}, matching commands ${JSON.stringify(loaded)}`)
}

async function probeFacts() {
  const probes: ShellProbe[] = [
    { name: 'shell', cmd: 'echo "SHELL=[$SHELL]"; getent passwd "$(id -u)"; id' },
    { name: 'tmpdir', cmd: 'echo "TMPDIR=$TMPDIR"; umask; touch "$TMPDIR/p" && ls -ld "$TMPDIR" && echo wrote' },
    { name: 'ns', cmd: 'readlink /proc/self/ns/ipc /proc/self/ns/pid /proc/self/ns/net /proc/self/ns/user /proc/self/ns/mnt | tr "\\n" " "' },
    { name: 'unix-socket', cmd: `python3 -c 'import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); print("made")'; python3 -c 'import socket; socket.socketpair(); print("made pair")'` },
    { name: 'seccomp', cmd: 'grep -E "Seccomp|NoNewPrivs" /proc/self/status | tr "\\n" " "' },
    { name: 'ps', cmd: 'ps -eo pid,user,args --no-headers | head -20' },
    { name: 'sysctl', cmd: 'cat /proc/sys/fs/protected_hardlinks /proc/sys/fs/protected_symlinks | tr "\\n" " "' },
  ]
  const script = shellScript(probes)
  const { done } = startRun({ chatId: 'p-facts', script: { steps: [bash(script)] } })
  const r = await done
  checkRun('facts', r, [0])
  const real = parseShell(result(r, 0)?.text ?? '')
  const off = await userShell(userNamed('s50'), script)
  judge('facts', real, off, [{ name: 'shell' }, { name: 'tmpdir' }, { name: 'ns' }, { name: 'unix-socket', leak: (x) => x.out.includes('made') }, { name: 'seccomp' }, { name: 'ps' }, { name: 'sysctl' }])
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
    record('init.plugins-ours-plus-sec-default', JSON.stringify(plugins) === JSON.stringify([PLUGIN_NAME, 'sec-default'].sort()), JSON.stringify(plugins))
    fact('init.slash_commands', JSON.stringify(init.slash_commands))
    const offOnes = init.slash_commands.filter((c) => (BUNDLED_SKILLS_OFF as readonly string[]).includes(c.replace(/^\//, '')))
    record('init.no-turned-off-command', offOnes.length === 0, JSON.stringify(offOnes))
  } else record('init.seen', false, 'no init message on the stream')
}

async function probeLongTmpdir() {
  const chatId = `p-long-${'x'.repeat(57)}`
  const { done } = startRun({ chatId, script: { steps: [bash('echo "TMPDIR=$TMPDIR"; touch "$TMPDIR/probe-long" && echo wrote; ls -ld "$TMPDIR"')] } })
  const r = await done
  checkRun('long-tmpdir', r, [0])
  fact('tmpdir.long-chat-id', result(r, 0)?.text.replace(/\n/g, ' ') ?? 'no output')
  // The run is over and its uid released: nothing it left in a shared folder may still be there.
  const left = await runCommand('find', ['/tmp', '/var/tmp', '/dev/shm', '-xdev', '-name', 'probe-long'])
  record('long-tmpdir.wiped-at-release', left.out.trim() === '', `left: ${left.out.trim() || 'nothing'}`)
}

const expanded = (requests: unknown[]) => {
  const t = JSON.stringify(requests)
  return t.includes('<command-name>/code-review</command-name>') || t.includes('<command-message>code-review')
}

async function probeCodeReview() {
  const r = await startRun({ chatId: 'p-cr', prompt: '/code-review', script: { steps: [] } }).done
  const t = terminalOf(r)
  fact('code-review.typed', `model requests ${r.state.requests.length}, end ${JSON.stringify(t)?.slice(0, 300)}, sdk results ${JSON.stringify(sdkMessages(r.events).filter((m) => m.type === 'result').map((m) => String(m.result ?? '').slice(0, 200)))}`)
  const off = await direct('skills-not-off', { prompt: '/code-review', webFetchDomains: [] }, { steps: [] })
  record('code-review.refused', !expanded(r.state.requests) && expanded(off.state.requests), `agent expanded: ${expanded(r.state.requests)} | guard off (skillOverrides removed): ${expanded(off.state.requests) ? 'expanded' : 'NOT EXPANDED: the probe cannot detect this'}`)
}

async function probeIsolation() {
  const wa = sessionPaths('p-iso-a').workDir
  const a = startRun({
    chatId: 'p-iso-a',
    script: {
      steps: [
        bash(
          `echo CANARY_A_FILE > inputs/secret.txt; echo CANARY_A_TMPDIR > "$TMPDIR/secret"; echo CANARY_A_HOME > "$HOME/secret"; echo CANARY_A_TMP > /tmp/iso-a-secret; ls -l inputs/secret.txt; ` +
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
    return procs().find((p) => p.cmdline.includes('canary-A-cmdline-holder') && p.uid !== 0)
  }, "A's holder process", 60_000)
  const aSession = procs().find((p) => p.cwd === wa && /session\/main\.mjs|probes\/direct\.mjs/.test(p.cmdline))
  fact('isolation.a', `holder pid ${holder.pid} uid ${holder.uid}, session pid ${aSession?.pid}`)

  let bSession: Proc | undefined
  const findB = () => (bSession ??= procs().find((p) => p.cwd === sessionPaths('p-iso-b').workDir && /session\/main\.mjs|probes\/direct\.mjs/.test(p.cmdline)))
  const split = (t: string) => [t.slice(0, 20), t.slice(20)]
  const filesProbes = (): ShellProbe[] => [
    { name: 'ls-work', cmd: 'ls -la /work' },
    { name: 'ls-a', cmd: `ls -la ${wa} ${wa}/inputs ${wa}/.tmp ${wa}/.home` },
    { name: 'cat-a-file', cmd: `cat ${wa}/inputs/secret.txt` },
    { name: 'cat-a-tmpdir', cmd: `cat ${wa}/.tmp/secret` },
    { name: 'cat-a-home', cmd: `cat ${wa}/.home/secret` },
    { name: 'cat-a-tmp', cmd: 'cat /tmp/iso-a-secret' },
    { name: 'grep-shared', cmd: `grep -rs 'CANARY.A' /tmp /var/tmp /dev/shm /run/lock` },
    { name: 'proc-holder', cmd: `tr '\\0' ' ' < /proc/${holder.pid}/cmdline; tr '\\0' ' ' < /proc/${holder.pid}/environ` },
    { name: 'proc-a-session', cmd: `tr '\\0' ' ' < /proc/${aSession?.pid}/environ; tr '\\0' ' ' < /proc/${aSession?.pid}/cmdline` },
    { name: 'proc-all', cmd: `for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline; tr '\\0' ' ' < $p/environ; done 2>/dev/null | grep -o 'CANARY.A[A-Z_]*\\|canary.A[a-z-]*' | sort -u` },
    { name: 'ps', cmd: 'ps -eo pid,user,args --no-headers | head -30' },
  ]
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
        name: 'channel',
        cmd: `env | grep NODE_CHANNEL; ls -l /proc/${findB()?.pid}/fd 2>&1 | head -5; echo probe > /proc/${findB()?.pid}/fd/1 && echo WROTE; timeout 2 head -c 1 /proc/${findB()?.pid}/fd/0 && echo READ0; ls -l /proc/self/fd /proc/$PPID/fd 2>&1 | grep -c socket`,
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
        () => ({ tool: 'Read', input: { file_path: `${wa}/.tmp/secret` } }),
        () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path: '/tmp', output_mode: 'content' } }),
        () => ({ tool: 'Grep', input: { pattern: 'CANARY.A', path: '/work', output_mode: 'content' } }),
        () => ({ tool: 'Glob', input: { pattern: '**/*', path: wa } }),
        () => {
          findB()
          tokenScript = shellScript(tokenProbes(b.run.token))
          return bash(tokenScript)()
        },
      ],
    },
  })
  const rb = await b.done
  // A's process ends once the probe is done (a condition, not a timer).
  appendFileSync(join(wa, 'outputs', '.go'), '')
  const ra = await a.done
  checkRun('isolation.a', ra, [0])
  checkRun('isolation.b', rb, [0, 9])
  fact('isolation.a-wrote', ra.state.results.get(ra.state.ids[0]!)?.text.slice(0, 300) ?? '')

  const canary = (t: string) => /CANARY_A|canary-A-cmdline/.test(t)
  const files = filesProbes()
  const real = parseShell(result(rb, 0)?.text ?? '')
  // Guard off: root reads the same (A's files are still there; its holder has ended, so the /proc probes use A's session-less view).
  const off = await rootShell(shellScript(files))
  // A file A couldn't make (its sandbox may not let it write /tmp) can't be judged: printed as a fact instead.
  const observeOnly = ['ls-work', 'ps', 'proc-holder', 'proc-a-session', 'proc-all', ...(existsSync('/tmp/iso-a-secret') ? [] : ['cat-a-tmp', 'grep-shared'])]
  judge(
    'isolation.bash',
    real,
    off,
    files.map((p) =>
      observeOnly.includes(p.name) ? { name: p.name } : { name: p.name, leak: (x: ShellResult) => canary(x.out) || (p.name === 'ls-a' && x.out.includes('secret.txt')) },
    ),
  )
  rmSync('/tmp/iso-a-secret', { force: true })
  // The /proc probes: A's holder is gone by now, so they're judged on the agent's run alone (and printed above).
  for (const n of ['proc-holder', 'proc-a-session', 'proc-all']) {
    const x = real.get(n)
    record(`isolation.bash.${n}-no-canary`, x !== undefined && !canary(x.out), x?.out.slice(0, 200) ?? 'no output')
  }
  const tools = ['read-a-file', 'read-a-tmp', 'read-a-holder-cmdline', 'read-a-holder-environ', 'read-a-tmpdir', 'grep-tmp', 'grep-work', 'glob-a']
  const offReadable = [`${wa}/inputs/secret.txt`, `${wa}/.tmp/secret`].every((p) => canary(readFileSync(p, 'utf8')))
  tools.forEach((n, i) => {
    const t = result(rb, i + 1)
    const leak = t !== undefined && (canary(t.text) || (n === 'glob-a' && t.text.includes('secret.txt')))
    record(`isolation.tool.${n}`, t !== undefined && !leak && offReadable, `agent: ${t?.text.slice(0, 200)} | guard off (root reads A's files): ${offReadable ? 'leak seen' : 'NO LEAK SEEN'}`)
  })

  const tok = parseShell(result(rb, 9)?.text ?? '')
  if (rb.via === 'direct') {
    record('token.not-reachable', false, 'needs the root path (the token lives only in the root): sessions through the root crash, see root.session-starts')
    record('channel.not-reachable', false, "needs the root path (the session's stdin and stdout channel): see root.session-starts")
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
  const chLeak = (t: string) => /socket:\[|WROTE|READ0|NODE_CHANNEL_FD=/.test(t)
  const chOff = await runCommand('bash', ['-c', `ls -l /proc/${aSession?.pid ?? 1}/fd`])
  record('channel.not-reachable', ch !== undefined && !chLeak(ch.out) && rb.events.every((e) => !(e.type === 'failed' && e.reason === 'protocol')), `agent: ${ch?.out.slice(0, 200)}, run end ${JSON.stringify(terminalOf(rb))?.slice(0, 120)} | root's view of a session's fds: ${chLeak(chOff.out) ? 'sockets seen' : chOff.out.slice(0, 120)}`)
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
  const again = await startRun({ chatId: 'p-nproc', script: { steps: [] } }).done
  const after = (await health())?.quarantinedUsers ?? -1
  record('process-limit.release-still-passes', before === after && r.cleanup === '' && terminalOf(again)?.type === 'finished', `release ${r.cleanup || 'passed'}; quarantined before ${before}, after ${after}; next run ${JSON.stringify(terminalOf(again))?.slice(0, 120)}`)
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
  const four = await direct('four-tools', { prompt: 'Say hi.', webFetchDomains: [], mcpUrl: `http://127.0.0.1:${egress.port}/mcp` }, { steps: [] })
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

  // deniedDomains with an IP literal.
  const curl = { steps: [bash(`curl -sS -m 8 ${GW_URL}`)] }
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
  record('strictAllowlist.unlisted-refused-without-asking', !got(on).includes(GW_OK) && asks(on) === '[]', `on: ${got(on).slice(0, 120)} asks ${asks(on)}`)
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
await step('egress', probeEgress)
await step('no-unsandboxed-retry', probeNoUnsandboxedRetry)
await step('claude-dir', probeClaudeDir)
await step('facts', probeFacts)
await step('long-tmpdir', probeLongTmpdir)
await step('code-review', probeCodeReview)
await step('isolation', probeIsolation)
await step('process-limit', probeProcessLimit)
await step('direct', probeDirect)
await step('sysv', probeSysV)
await step('closed-folder', probeClosedFolder)
await step('zombie-leader', probeZombieLeader)

const h = await health()
record('root.still-healthy', h?.ok === true && h.live === 0, JSON.stringify(h))
record('egress.no-unknown-token-calls', egress.refused.length === 0, JSON.stringify(egress.refused))
root!.kill('SIGTERM')
await waitUntil(() => root.exitCode !== null || root.signalCode !== null, 'the root to stop', 30_000)
await egress.close()

const failed = outcomes.filter((o) => !o.ok)
console.log(`\n${outcomes.length - failed.length} of ${outcomes.length} probes passed, ${facts.length} facts`)
if (failed.length > 0) {
  console.log(`FAILED: ${failed.map((f) => f.name).join(', ')}`)
  console.log('--- root log (last 80 lines)')
  for (const l of rootLog.slice(-80)) console.log(l.slice(0, 400))
}
process.exit(failed.length === 0 ? 0 : 1)
