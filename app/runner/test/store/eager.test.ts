// `sessionStoreFlush: 'eager'` against a hard kill (P0 S1's open item), with the real SDK and CLI against the scripted
// model; no real model call. Ways it could fail, written first:
// - with eager, the live turn (a tool call and its result, written before the CLI asks the model again) never reaches
//   the store before the kill, so a resume loses it;
// - the store holds a turn's entries out of order or twice, so the resume reads a broken transcript;
// - a resume from the store in a fresh config dir (a new container) doesn't see the turn cut off by the kill.
// The batched control shows the gap eager closes: killed at the same point, the store lacks the live turn.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScriptedModel, type MessagesRequest, type ScriptedModel } from '../../../test/scripted-model/index.ts'
import { PROXY_URL, fakeEgress, type FakeEgress } from '../run/support/fake-egress.ts'

const runner = fileURLToPath(new URL('../../', import.meta.url))
const SESSION_ID = '0d6c1f8e-4b2a-4c1e-9a77-5e2b3c4d5e6f'
const GLOB_ID = 'toolu_scripted_glob'

let bundle: string
let tmp: string[] = []
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  tmp.push(d)
  return d
}

beforeAll(() => {
  // Inside the runner, so the external SDK resolves from its node_modules.
  const out = mkdtempSync(join(runner, 'node_modules', '.eager-test-'))
  tmp.push(out)
  bundle = join(out, 'eager-session.mjs')
  execFileSync(
    join(runner, 'node_modules/.bin/esbuild'),
    ['test/store/fixtures/eager-session.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--external:@anthropic-ai/claude-agent-sdk', '--alias:zod=./node_modules/zod/index.js', '--log-level=warning'],
    { cwd: runner, stdio: 'pipe' },
  )
})
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
  tmp = []
})

/** Serves a `fetch`-shaped handler on loopback. */
async function serve(handle: (req: Request) => Promise<Response>): Promise<{ url: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const r = await handle(new Request(`http://local${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) }))
    res.writeHead(r.status, Object.fromEntries(r.headers))
    res.end(Buffer.from(await r.arrayBuffer()))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.closeAllConnections() }
}

const storeServer = (egress: FakeEgress) =>
  serve(async (req) => egress.fetch(`${PROXY_URL}${new URL(req.url).pathname}`, { method: req.method, headers: { 'content-type': 'application/json' }, body: await req.text() }))

type Run = { child: ChildProcess; out: () => Promise<string>; exited: Promise<number | null>; stderr: () => string }

function startSession(o: { storeUrl: string; modelUrl: string; flush: string; prompt: string; resume: boolean; work: string; configDir: string; bash?: boolean }): Run {
  const child = spawn(process.execPath, [bundle], {
    cwd: o.work,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH!,
      HOME: o.work,
      CLAUDE_CONFIG_DIR: o.configDir,
      ANTHROPIC_BASE_URL: `${o.modelUrl}/model`,
      ANTHROPIC_API_KEY: 'scripted-model-takes-no-key',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1',
      STORE_URL: o.storeUrl,
      FLUSH: o.flush,
      PROMPT: o.prompt,
      SESSION_ID,
      RESUME: o.resume ? '1' : '0',
      WORK_DIR: o.work,
      SPIKE_BASH: o.bash === true ? '1' : '0',
    },
  })
  let out = ''
  let err = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')))
  child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')))
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)))
  return { child, exited, stderr: () => err, out: () => exited.then(() => (out === '' ? Promise.reject(new Error(`no output; stderr: ${err.slice(-2000)}`)) : out)) }
}

/** Whether `cond` holds within `ms`, checked every 25 ms. */
async function within(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 25))
  }
  return true
}

async function until(cond: () => boolean, what: string, ms = 60_000) {
  if (!(await within(cond, ms))) throw new Error(`${what}: not met in ${ms} ms`)
}

/** How long the store gets to show the live turn after the CLI asks for turn 1, in both arms. */
const STORE_WAIT_MS = 20_000

/** The session's main transcript as the store holds it, in part order. */
const stored = (egress: FakeEgress) =>
  [...egress.parts.keys()]
    .map((k) => JSON.parse(k) as [string, string, string | null])
    .filter(([, s, sub]) => s === SESSION_ID && sub === null)
    .flatMap(([p, s]) => egress.entries({ projectKey: p, sessionId: s })) as { type?: string; uuid?: string; message?: { content?: unknown } }[]

const liveTurnOf = (egress: FakeEgress, id: string) => {
  const entries = stored(egress).map((e) => JSON.stringify(e.message?.content ?? null))
  return { call: entries.findIndex((c) => c.includes(`"id":"${id}"`)), result: entries.findIndex((c) => c.includes(`"tool_use_id":"${id}"`)) }
}

/** Where the live turn's two entries sit in the stored transcript: the tool call, then its result (-1 when missing). */
function liveTurn(egress: FakeEgress) {
  const entries = stored(egress).map((e) => JSON.stringify(e.message?.content ?? null))
  return { call: entries.findIndex((c) => c.includes(`"id":"${GLOB_ID}"`)), result: entries.findIndex((c) => c.includes(`"tool_use_id":"${GLOB_ID}"`)) }
}

/**
 * Turn 0 makes a tool call; the CLI answers it with a tool result (an error result: Glob isn't in this CLI's tool set,
 * which doesn't matter here) and asks for turn 1, which is held until the test kills the session.
 */
function cutScenario(held: Promise<void>): ScriptedModel {
  return createScriptedModel({
    cut: {
      turns: [
        { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: GLOB_ID, name: 'Glob', input: { pattern: '*' } }] },
        { content: [{ type: 'text', text: 'never sent' }], hold: () => held },
      ],
    },
  })
}

const hasToolResult = (r: MessagesRequest) => JSON.stringify(r.messages).includes(`"tool_use_id":"${GLOB_ID}"`)

/** SIGKILLs the session's whole process group; a group already gone (ESRCH) is fine, anything else isn't. */
function killGroup(run: Run) {
  try {
    process.kill(-run.child.pid!, 'SIGKILL')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
  }
}

/**
 * Runs the cut scenario to turn 1, gives the store the full wait to show the live turn, then kills the session.
 * `storeHeld`: whether the store showed it within the wait.
 */
async function killMidTurn(flush: 'eager' | 'batched') {
  const egress = fakeEgress()
  let release!: () => void
  const held = new Promise<void>((r) => (release = r))
  const model = cutScenario(held)
  const store = await storeServer(egress)
  const modelServer = await serve((req) => model.handle(req, 'cut'))
  const work = temp('eager-work-')
  const configDir = temp('eager-cfg-')
  const run = startSession({ storeUrl: store.url, modelUrl: modelServer.url, flush, prompt: 'list the files', resume: false, work, configDir })
  try {
    // The CLI ran the tool and is waiting on the model for turn 1: the live turn is on its local disk.
    await until(() => model.log.some((l) => l.turn === 1), 'the CLI to reach turn 1')
    // The CLI writes the tool result before it asks for turn 1, and eager mirrors each entry as it's written, so with
    // eager the store gets the whole live turn while the CLI waits. Batched holds it until the turn ends, never here.
    // Both arms wait the same, so each tells eager from batched on its own.
    const storeHeld = await within(() => liveTurn(egress).result >= 0, STORE_WAIT_MS)
    killGroup(run)
    await run.exited
    return { egress, model, store, modelServer, work, release, storeHeld }
  } catch (e) {
    killGroup(run)
    release()
    store.close()
    modelServer.close()
    throw e
  }
}

describe("sessionStoreFlush: 'eager' against a hard kill", () => {
  it('the live turn reaches the store before the kill, in order, once; a fresh container resumes it from the store', async () => {
    const k = await killMidTurn('eager')
    try {
      expect(k.storeHeld, 'the store to hold the live turn (eager) before the kill').toBe(true)
      expect(k.model.misses).toEqual([])
      const turn = liveTurn(k.egress)
      expect(turn.call).toBeGreaterThanOrEqual(0)
      expect(turn.result).toBeGreaterThan(turn.call)
      const uuids = stored(k.egress).flatMap((e) => (typeof e.uuid === 'string' ? [e.uuid] : []))
      expect(new Set(uuids).size).toBe(uuids.length)

      // A new container: an empty config dir; the store is all there is.
      const resumeModel = createScriptedModel({
        // Turn 2: the resumed transcript holds the cut turn's assistant message, then the one the CLI adds on resume
        // for the turn that never got its answer ("No response requested.").
        resume: { turns: [null, null, { content: [{ type: 'text', text: 'resumed from the store' }], expect: hasToolResult }] },
      })
      const m2 = await serve((req) => resumeModel.handle(req, 'resume'))
      try {
        const run = startSession({ storeUrl: k.store.url, modelUrl: m2.url, flush: 'eager', prompt: 'go on', resume: true, work: k.work, configDir: temp('eager-cfg2-') })
        const line = JSON.parse((await run.out()).trim().split('\n').at(-1)!) as { result: string; checkpoint: { ok: boolean } }
        expect(resumeModel.misses).toEqual([])
        expect(line).toMatchObject({ result: 'resumed from the store', checkpoint: { ok: true } })
      } finally {
        m2.close()
      }
    } finally {
      k.release()
      k.store.close()
      k.modelServer.close()
    }
  }, 120_000)

  it('the batched control: given the same wait and killed at the same point, the store lacks the live turn', async () => {
    const k = await killMidTurn('batched')
    try {
      expect(k.storeHeld, 'the store not to hold the live turn (batched) within the full wait').toBe(false)
      expect(k.model.misses).toEqual([])
      expect(liveTurn(k.egress).result).toBe(-1)
    } finally {
      k.release()
      k.store.close()
      k.modelServer.close()
    }
  }, 120_000)

  // W0-B spike only (draft PR, never merged): a kill while a tool is still running leaves a tool_use with no result in
  // the store. Does the SDK resume cleanly on that tail, and is the request it sends one a real API accepts?
  it('W0-B spike: killed mid-tool, the resume from the store sends every tool_use with its result', async () => {
    const egress = fakeEgress()
    const toolId = 'toolu_spike_sleep'
    const model = createScriptedModel({
      cut: { turns: [{ content: [{ type: 'text', text: 'Waiting.' }, { type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'sleep 20 && echo waited', description: 'Wait' } }] }, null] },
    })
    const store = await storeServer(egress)
    const modelServer = await serve((req) => model.handle(req, 'cut'))
    const work = temp('spike-work-')
    const run = startSession({ storeUrl: store.url, modelUrl: modelServer.url, flush: 'eager', prompt: 'wait', resume: false, work, configDir: temp('spike-cfg-'), bash: true })
    try {
      await until(() => model.log.some((l) => l.turn === 0 && !l.missed), 'turn 0 answered')
      await until(() => liveTurnOf(egress, toolId).call >= 0, 'the tool call in the store')
      // Killed while the sleep runs: well inside its 20 s.
      expect(liveTurnOf(egress, toolId).result).toBe(-1)
      killGroup(run)
      await run.exited
    } catch (e) {
      console.log('W0-B spike local cut failed', String(e), model.log, run.stderr().slice(-1500))
      throw e
    } finally {
      try { killGroup(run) } catch { /* the group may already be gone (EPERM on macOS for a reaped group) */ }
      modelServer.close()
    }
    const tail = stored(egress)
    expect(liveTurnOf(egress, toolId).result, 'no result in the store: the tail ends on the open tool call').toBe(-1)
    const bodies: MessagesRequest[] = []
    const resumeModel = createScriptedModel({ r: { turns: Array.from({ length: 6 }, () => ({ content: [{ type: 'text' as const, text: 'resumed from the store' }] })) } })
    const m2 = await serve(async (req) => {
      if (new URL(req.url).pathname.endsWith('/v1/messages')) bodies.push((await req.clone().json()) as MessagesRequest)
      return resumeModel.handle(req, 'r')
    })
    try {
      const run2 = startSession({ storeUrl: store.url, modelUrl: m2.url, flush: 'eager', prompt: 'go on', resume: true, work, configDir: temp('spike-cfg2-'), bash: true })
      const line = JSON.parse((await run2.out()).trim().split('\n').at(-1)!) as { result: string; checkpoint: { ok: boolean } }
      const main = bodies.filter((b) => Array.isArray(b.tools) && b.tools.length > 0)
      const msgs = main[0]!.messages
      const blocks = (m: (typeof msgs)[number]) => (Array.isArray(m.content) ? (m.content as { type?: string; id?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) : [])
      const unpaired: string[] = []
      msgs.forEach((m, i) => {
        if (m.role !== 'assistant') return
        const next = msgs.slice(i + 1).find((n) => n.role !== 'system')
        const got = new Set(next?.role === 'user' ? blocks(next).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id) : [])
        unpaired.push(...blocks(m).filter((b) => b.type === 'tool_use').map((b) => b.id!).filter((id) => !got.has(id)))
      })
      const use = msgs.some((m) => blocks(m).some((b) => b.type === 'tool_use' && b.id === toolId))
      const res = msgs.flatMap(blocks).find((b) => b.type === 'tool_result' && b.tool_use_id === toolId)
      console.log('W0-B spike local', JSON.stringify({ storeTail: tail.length, roles: msgs.map((m) => m.role[0]).join(''), toolUseSent: use,
        toolResult: res === undefined ? null : { isError: res.is_error === true, said: JSON.stringify(res.content).slice(0, 160) }, unpaired, result: line.result, checkpoint: line.checkpoint.ok }))
      expect(resumeModel.misses).toEqual([])
      expect(line).toMatchObject({ result: 'resumed from the store', checkpoint: { ok: true } })
      expect(unpaired).toEqual([])
    } finally {
      m2.close()
      store.close()
    }
  }, 120_000)
})
