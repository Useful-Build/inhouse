#!/usr/bin/env node
// Run: `node app/runner/harness/s6-check.mjs <out dir> [port]` (Docker up, harness `npm ci` done); its CI job was removed after S6 (docs/decisions/p3-local-containers.md; the job is in git history at e48242e).
// Spike S6: one chat end to end with the runner image under `wrangler dev`, the SDK sandbox on, one OS user per
// session. Starts the harness, runs three scripted chats, watches the container's processes and fails on any miss.
// Run from anywhere, with the harness's `npm ci` done and Docker up:
//   node app/runner/harness/s6-check.mjs <out dir> [port]
// On a GitHub runner the sandbox can't start (S6); on the Mac it needs Rosetta 2 (see the P3 plan, S6) and the
// heavy lock. Everything it saw goes to <out dir>: wrangler.log, container.log, the runs' NDJSON, ps.log, facts.json,
// summary.json. It stops wrangler dev and removes every container that came up while it ran.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(process.argv[2] ?? 's6-out')
const PORT = Number(process.argv[3] ?? 8799)
const BASE = `http://127.0.0.1:${PORT}`
const HEALTH_DEADLINE_MS = 30 * 60_000 // a cold image build comes first
const RUN_DEADLINE_MS = 5 * 60_000
const POOL = { first: 30000, last: 30063 }
const CLI = '/opt/runner/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude'
const SAMPLER = 's6-ps-sampler'
const TABLE = 'sku,qty\nA1,3\n'

mkdirSync(OUT, { recursive: true })
const t0 = Date.now()
const log = (msg) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`
  console.log(line)
  writeFileSync(join(OUT, 'steps.log'), line + '\n', { flag: 'a' })
}
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
const sh = (cmd, args, opts = {}) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts }) }
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || String(e.message) }
  }
}
const dockerIds = () => new Set(sh('docker', ['ps', '-aq', '--no-trunc']).out.split('\n').filter(Boolean))

const before = dockerIds()
const facts = { startedAt: new Date().toISOString() }
let dev
let sampler
let samplerDone
let cid
let failedEarly

async function main() {
  facts.docker = sh('docker', ['version', '--format', '{{.Server.Version}} {{.Server.Arch}} {{.Server.Os}}']).out.trim()
  facts.dockerInfo = sh('docker', ['info', '--format', '{{json .SecurityOptions}} driver={{.Driver}} cgroup={{.CgroupVersion}}']).out.trim()
  facts.dockerHost = process.env.DOCKER_HOST ?? null
  facts.devFuseOnHost = sh('test', ['-c', '/dev/fuse']).ok
  facts.wrangler = sh('npx', ['wrangler', '--version'], { cwd: HERE }).out.trim()
  facts.host = {
    kernel: sh('uname', ['-srm']).out.trim(),
    apparmor_restrict_unprivileged_userns: readMaybe('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'),
    unprivileged_userns_clone: readMaybe('/proc/sys/kernel/unprivileged_userns_clone'),
    max_user_namespaces: readMaybe('/proc/sys/user/max_user_namespaces'),
  }

  log(`wrangler dev on ${PORT}`)
  const wlog = createWriteStream(join(OUT, 'wrangler.log'))
  dev = spawn('npx', ['wrangler', 'dev', '--var', 'HARNESS_LOCAL_ONLY:1', '--port', String(PORT), '--ip', '127.0.0.1'], {
    cwd: HERE,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  dev.stdout.pipe(wlog)
  dev.stderr.pipe(wlog)
  let devExit
  dev.on('exit', (code, signal) => (devExit = { code, signal }))

  // Wait on the condition: /health from the runner, through the harness (the first call starts the container).
  const healthStart = Date.now()
  let health
  for (;;) {
    if (devExit) throw new Error(`wrangler dev exited (${JSON.stringify(devExit)}) before /health answered; see wrangler.log`)
    if (Date.now() - healthStart > HEALTH_DEADLINE_MS) throw new Error(`no /health after ${HEALTH_DEADLINE_MS / 60_000} min; see wrangler.log`)
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(90_000) }).catch(() => null)
    if (res?.ok) {
      health = await res.json()
      break
    }
    await res?.body?.cancel()
    await new Promise((r) => setTimeout(r, 2000)) // poll interval, not a wait for an outcome
  }
  facts.healthSeconds = (Date.now() - healthStart) / 1000
  writeFileSync(join(OUT, 'health.json'), JSON.stringify(health, null, 2))
  log(`/health after ${facts.healthSeconds}s: ${JSON.stringify(health)}`)

  // The runner's container: the one that holds the runner's entry (wrangler dev may run other containers beside it).
  const fresh = [...dockerIds()].filter((id) => !before.has(id))
  cid = fresh.find((id) => sh('docker', ['exec', id, 'test', '-f', '/opt/runner/dist/main.mjs']).ok)
  facts.containers = sh('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Image}} {{.Names}} {{.Status}}']).out.trim().split('\n')
  if (!cid) throw new Error(`no runner container among the new ones: ${fresh.join(' ') || 'none'}`)
  log(`runner container ${cid.slice(0, 12)}`)
  facts.inspect = JSON.parse(sh('docker', ['inspect', cid, '--format',
    '{"capAdd":{{json .HostConfig.CapAdd}},"capDrop":{{json .HostConfig.CapDrop}},"securityOpt":{{json .HostConfig.SecurityOpt}},"privileged":{{.HostConfig.Privileged}},"user":{{json .Config.User}},"image":{{json .Config.Image}},"maskedPaths":{{json .HostConfig.MaskedPaths}},"networkMode":{{json .HostConfig.NetworkMode}},"devices":{{json .HostConfig.Devices}}}']).out)
  const inC = (script, user) => sh('docker', ['exec', ...(user ? ['-u', user] : []), cid, 'sh', '-c', script])
  facts.container = {
    id: inC('id').out.trim(),
    unprivileged_userns_clone: inC('cat /proc/sys/kernel/unprivileged_userns_clone 2>&1').out.trim(),
    max_user_namespaces: inC('cat /proc/sys/user/max_user_namespaces 2>&1').out.trim(),
    uname: inC('uname -m').out.trim(),
    cliVersion: inC(`${CLI} --version 2>&1`).out.trim(),
    sdkVersion: inC("node -p \"require('/opt/runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version\" 2>&1").out.trim(),
    bwrapVersion: inC('bwrap --version 2>&1').out.trim(),
    // What the sandbox needs from the platform, as a pool user no run uses (s63): a PID namespace and a user namespace.
    bwrapAsPoolUser: inC('bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid --die-with-parent true 2>&1; echo rc=$?', '30063:30063').out.trim(),
    unshareUserAsPoolUser: inC('unshare -U true 2>&1; echo rc=$?', '30063:30063').out.trim(),
  }

  const protocolRes = await fetch(`${BASE}/protocol`)
  const protocol = await protocolRes.json()
  writeFileSync(join(OUT, 'protocol.json'), JSON.stringify(protocol, null, 2))
  const sourceVersion = Number(/PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(HERE, '../../shared/protocol/index.ts'), 'utf8'))?.[1])
  check('protocol', protocolRes.ok && protocol.version === health.protocol && protocol.version === sourceVersion && protocol.accepted?.includes(protocol.version),
    `/protocol ${JSON.stringify(protocol)}, /health protocol ${health.protocol}, source PROTOCOL_VERSION ${sourceVersion}`)

  // Watch the processes during the runs, from inside the container (no docker exec per sample, so short-lived bwrap
  // processes are caught): uid, pid, ppid and the full command line, every 20 ms.
  sampler = spawn('docker', ['exec', cid, 'sh', '-c', 'while :; do echo "=== $(date +%s.%N)"; ps -ww -eo uid,pid,ppid,args; sleep 0.02; done', SAMPLER], { stdio: ['ignore', 'pipe', 'pipe'] })
  const psFile = createWriteStream(join(OUT, 'ps.log'))
  sampler.stdout.pipe(psFile)
  samplerDone = new Promise((r) => psFile.on('close', r))

  const runs = {}
  runs.a = await run('hello', 'chat-a', 'hello-a')
  runs.c = await run('write-output', 'chat-c', 'write-c')
  const afterC = outputsState()
  runs.b = await run('write-output', 'chat-b', 'write-b')
  const afterB = outputsState()
  await stopSampler()

  const modelLog = await (await fetch(`${BASE}/model-log`)).json()
  writeFileSync(join(OUT, 'model-log.json'), JSON.stringify(modelLog, null, 2))
  check('scripted-model.no-misses', Array.isArray(modelLog.misses) && modelLog.misses.length === 0, `${modelLog.log?.length} requests, misses ${JSON.stringify(modelLog.misses)}`)

  // 1. Each run ends with its scripted result.
  for (const [k, r] of Object.entries(runs)) {
    const finished = r.events.find((e) => e.type === 'finished')
    const failed = r.events.filter((e) => e.type === 'failed')
    const texts = r.events.filter((e) => e.type === 'sdk' && e.message?.type === 'result').map((e) => e.message.result)
    const want = r.scenario === 'hello' ? 'Hello from the scripted model.' : 'Saved outputs/table.csv.'
    check(`run.${k}.result`, r.status === 200 && failed.length === 0 && finished && !finished.isError && finished.subtype === 'success' && texts.includes(want),
      `${r.scenario} on ${r.chatId}: HTTP ${r.status}, ${r.seconds}s, finished ${JSON.stringify(finished ?? null)}, failed ${JSON.stringify(failed)}, result ${JSON.stringify(texts)}`)
    if (r.scenario === 'write-output') {
      const saved = r.events.find((e) => e.type === 'file_saved')
      const toolResults = r.events.flatMap((e) => (e.type === 'sdk' && e.message?.type === 'user' ? e.message.message?.content ?? [] : [])).filter((c) => c?.type === 'tool_result')
      check(`run.${k}.file-saved`, saved?.path === 'outputs/table.csv' && saved.bytes === TABLE.length, `file_saved ${JSON.stringify(saved ?? null)}; Bash tool_result ${JSON.stringify(toolResults).slice(0, 400)}`)
    }
  }

  // 2. The output lands in its own chat's outputs/ and nowhere else.
  check('outputs.after-chat-c', afterC['chat-c'] === TABLE && afterC['chat-b'] === null && afterC['chat-a'] === null, afterC)
  check('outputs.after-chat-b', afterB['chat-b'] === TABLE && afterB['chat-c'] === TABLE && afterB['chat-a'] === null, afterB)

  // 3. One pool user per session, never root: the root runner's release log names each chat's uid.
  const containerLog = sh('docker', ['logs', '-t', cid]).out
  writeFileSync(join(OUT, 'container.log'), containerLog)
  const released = containerLog.split('\n').map((l) => l.slice(l.indexOf('{'))).filter((l) => l.startsWith('{')).map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return null
    }
  }).filter((e) => e?.type === 'session_user_released')
  const uidOf = Object.fromEntries(released.map((e) => [e.sessionKey, e.uid]))
  const uids = ['chat-a', 'chat-c', 'chat-b'].map((c) => uidOf[c])
  check('users.distinct-pool-users', uids.every((u) => Number.isInteger(u) && u >= POOL.first && u <= POOL.last) && new Set(uids).size === 3, { uidOf, released: released.length })
  facts.uidOf = uidOf

  // From the process samples: every session process, CLI and bwrap ran as a pool uid, never root.
  const ps = parsePs(readFileSync(join(OUT, 'ps.log'), 'utf8'))
  const agentProcs = ps.filter((p) => p.args.includes('/opt/runner/dist/session/main.mjs') || p.args.includes('claude-agent-sdk-linux-x64/claude') || /(^|\/)bwrap\s/.test(p.args))
  const byUid = {}
  for (const p of agentProcs) (byUid[p.uid] ??= new Set()).add(kind(p.args))
  check('users.never-root', agentProcs.length > 0 && agentProcs.every((p) => p.uid >= POOL.first && p.uid <= POOL.last),
    { samples: ps.samples, agentProcessRows: agentProcs.length, byUid: Object.fromEntries(Object.entries(byUid).map(([u, s]) => [u, [...s]])) })

  // 4. The SDK sandbox ran the Bash call: bwrap under that chat's session uid, with the chat's folder in its mounts.
  for (const chat of ['chat-c', 'chat-b']) {
    const uid = uidOf[chat]
    const bw = agentProcs.filter((p) => p.uid === uid && /(^|\/)bwrap\s/.test(p.args))
    const withChat = bw.filter((p) => p.args.includes(`/work/${chat}`))
    // The uid is this chat's alone while its session lives (the pool hands each uid to one session at a time and
    // round-robins), so bwrap under it is this chat's sandbox; naming the folder is recorded, not required.
    check(`sandbox.${chat}.bwrap`, uid !== undefined && bw.length > 0, `uid ${uid}: ${bw.length} bwrap rows, ${withChat.length} naming /work/${chat}; first: ${(withChat[0] ?? bw[0])?.args.slice(0, 600) ?? 'none'}`)
  }
  facts.bwrapSample = agentProcs.find((p) => /(^|\/)bwrap\s/.test(p.args))?.args.slice(0, 4000) ?? null
  facts.runs = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { scenario: r.scenario, chatId: r.chatId, seconds: r.seconds, status: r.status }]))
}

async function run(scenario, chatId, file) {
  const started = Date.now()
  const res = await fetch(`${BASE}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scenario, chatId, prompt: `s6 ${scenario}` }),
    signal: AbortSignal.timeout(RUN_DEADLINE_MS),
  })
  const text = await res.text()
  const seconds = (Date.now() - started) / 1000
  writeFileSync(join(OUT, `${file}.ndjson`), text)
  const events = text.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return { type: 'unparsed', line: l.slice(0, 500) }
    }
  })
  log(`run ${scenario}/${chatId}: HTTP ${res.status}, ${seconds}s, ${events.length} events, last ${JSON.stringify(events.at(-1)).slice(0, 300)}`)
  return { scenario, chatId, status: res.status, seconds, events }
}

/** Each chat's outputs/table.csv as root sees it in the container, or null. */
function outputsState() {
  const state = {}
  for (const chat of ['chat-a', 'chat-b', 'chat-c']) {
    const r = sh('docker', ['exec', cid, 'cat', `/work/${chat}/outputs/table.csv`])
    state[chat] = r.ok ? r.out : null
  }
  return state
}

function parsePs(text) {
  const rows = []
  let samples = 0
  for (const line of text.split('\n')) {
    if (line.startsWith('===')) {
      samples++
      continue
    }
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (m && !m[4].includes(SAMPLER)) rows.push({ uid: Number(m[1]), pid: Number(m[2]), ppid: Number(m[3]), args: m[4] })
  }
  return Object.assign(rows, { samples })
}

const kind = (args) => (/(^|\/)bwrap\s/.test(args) ? 'bwrap' : args.includes('session/main.mjs') ? 'session' : 'cli')

function readMaybe(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

async function stopSampler() {
  if (!sampler) return
  if (cid) sh('docker', ['exec', cid, 'pkill', '-f', SAMPLER])
  sampler.kill()
  sampler = undefined
  await samplerDone // ps.log fully written before anyone reads it
}

async function cleanup() {
  await stopSampler()
  if (cid) {
    const logs = sh('docker', ['logs', '-t', cid])
    writeFileSync(join(OUT, 'container.log'), logs.out)
  }
  if (dev && dev.exitCode === null) {
    try {
      process.kill(-dev.pid, 'SIGINT')
    } catch {}
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          process.kill(-dev.pid, 'SIGKILL')
        } catch {}
        r()
      }, 15_000)
      dev.once('exit', () => (clearTimeout(t), r()))
    })
  }
  const started = [...dockerIds()].filter((id) => !before.has(id))
  for (const id of started) sh('docker', ['rm', '-f', id])
  facts.removedContainers = started.length
}

try {
  await main()
} catch (e) {
  failedEarly = String(e instanceof Error ? e.message : e)
  check('setup', false, failedEarly)
} finally {
  await cleanup()
  facts.totalSeconds = (Date.now() - t0) / 1000
  writeFileSync(join(OUT, 'facts.json'), JSON.stringify(facts, null, 2))
  const failed = results.filter((r) => !r.ok)
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ passed: failed.length === 0, results }, null, 2))
  log(failed.length === 0 ? `S6 PASS (${results.length} checks)` : `S6 FAIL: ${failed.map((r) => r.name).join(', ')}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}
