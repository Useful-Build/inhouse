// A deferred call across a container restart (Stage 1, N16), with the real SDK and CLI against the scripted model, the
// runner's own store adapter and prompts (no real model call): the first run defers its lone call and ends waiting; a
// fresh config dir (a new container, the same work folder path: the session's project key) resumes with `""` from the
// store alone. Ways it could fail, written first:
// - the store never gets the CLI's record of the deferral (its `hook_deferred_tool` attachment), so the resume treats the
//   call as cut off and asks the model with no result for it, instead of running it again;
// - the resume runs the call without its PreToolUse hook, or twice;
// - the resume's `""` adds a turn of its own after the deferred call (as a plain `""` string does: the control);
// - an MCP call run again carries no `_meta["claudecode/toolUseId"]`, so the server can't find its question.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScriptedModel, type MessagesRequest } from '../../../test/scripted-model/index.ts'
import { PROXY_URL, fakeEgress, type FakeEgress } from '../run/support/fake-egress.ts'

const runner = fileURLToPath(new URL('../../', import.meta.url))
const SESSION_ID = '1e7c2f9a-5b3b-4d2f-8a88-6f3c4d5e6f70'
const READ_ID = 'toolu_scripted_read'
const ASK_ID = 'toolu_scripted_ask'

let bundle: string
let tmp: string[] = []
const temp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p))
  tmp.push(d)
  return d
}
beforeAll(() => {
  const out = mkdtempSync(join(runner, 'node_modules', '.defer-test-'))
  tmp.push(out)
  bundle = join(out, 'defer-session.mjs')
  execFileSync(
    join(runner, 'node_modules/.bin/esbuild'),
    ['test/store/fixtures/defer-session.ts', '--bundle', '--platform=node', '--format=esm', `--outfile=${bundle}`, '--external:@anthropic-ai/claude-agent-sdk', '--alias:zod=./node_modules/zod/index.js', '--log-level=warning'],
    { cwd: runner, stdio: 'pipe' },
  )
})
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true })
  tmp = []
})

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

/** A small MCP server over HTTP (JSON answers only) with one tool, recording each `tools/call`'s `_meta`. */
const mcpServer = (calls: unknown[]) =>
  serve(async (req) => {
    if (req.method !== 'POST') return new Response(null, { status: 405 })
    const m = (await req.json()) as { id?: number; method: string; params?: { _meta?: unknown } }
    if (m.id === undefined) return new Response(null, { status: 202 })
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: m.id, result })
    if (m.method === 'initialize') return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'inhouse', version: '1' } })
    if (m.method === 'tools/list') return ok({ tools: [{ name: 'question_ask', description: 'Ask the person a question.', inputSchema: { type: 'object', properties: { question: { type: 'string' } } }, _meta: { 'anthropic/alwaysLoad': true } }] })
    if (m.method === 'tools/call') {
      calls.push(m.params?._meta ?? null)
      return ok({ content: [{ type: 'text', text: 'The person chose: "Yes".' }] })
    }
    return ok({})
  })

async function session(o: { storeUrl: string; modelUrl: string; work: string; prompt: string; resume: boolean; defer: boolean; tool: string; mcpUrl?: string; plain?: boolean }) {
  const child = spawn(process.execPath, [bundle], {
    cwd: o.work,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH!, HOME: o.work, CLAUDE_CONFIG_DIR: temp('defer-cfg-'), ANTHROPIC_BASE_URL: `${o.modelUrl}/model`,
      ANTHROPIC_API_KEY: 'scripted-model-takes-no-key', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTOUPDATER: '1', STORE_URL: o.storeUrl, PROMPT: o.prompt, SESSION_ID, RESUME: o.resume ? '1' : '0', DEFER: o.defer ? '1' : '0',
      WORK_DIR: o.work, TOOL: o.tool, ...(o.mcpUrl ? { MCP_URL: o.mcpUrl } : {}), ...(o.plain ? { PLAIN: '1' } : {}),
    },
  })
  let out = ''
  let err = ''
  child.stdout!.on('data', (d: Buffer) => (out += d.toString('utf8')))
  child.stderr!.on('data', (d: Buffer) => (err += d.toString('utf8')))
  await new Promise<void>((r) => child.on('close', () => r()))
  if (out.trim() === '') throw new Error(`no output; stderr: ${err.slice(-3000)}`)
  return out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
}

const answers = (id: string, text: string) => ({
  content: [{ type: 'text' as const, text }],
  expect: (r: MessagesRequest) => (JSON.stringify(r.messages).includes(`"tool_use_id":"${id}"`) ? true : `no result for ${id}`),
})

/** The first run (deferred), then the resume in a new config dir; returns both runs' lines and the scripted model. */
async function deferThenResume(o: { tool: string; id: string; input: Record<string, unknown>; mcpUrl?: string; plain?: boolean }) {
  const egress = fakeEgress()
  const store = await storeServer(egress)
  const model = createScriptedModel({ ask: { turns: [{ content: [{ type: 'tool_use', id: o.id, name: o.tool, input: o.input }] }, answers(o.id, 'answered')] } })
  const m = await serve((req) => model.handle(req, 'ask'))
  const work = temp('defer-work-')
  try {
    const base = { storeUrl: store.url, modelUrl: m.url, work, tool: o.tool, ...(o.mcpUrl ? { mcpUrl: o.mcpUrl } : {}) }
    const first = await session({ ...base, prompt: 'ask me', resume: false, defer: true })
    const stored = [...egress.parts.keys()].map((k) => JSON.parse(k) as [string, string, string | null])
      .filter(([, sid, sub]) => sid === SESSION_ID && sub === null).flatMap(([p, sid]) => egress.entries({ projectKey: p, sessionId: sid }))
    const second = await session({ ...base, prompt: '', resume: true, defer: false, ...(o.plain ? { plain: true } : {}) })
    return { first, second, model, stored: JSON.stringify(stored) }
  } finally {
    store.close()
    m.close()
  }
}

describe('a deferred call across a container restart (Stage 1, N16), the real CLI', () => {
  it('the resume from the store alone runs the call again through its hook, once; the model sees its result; one answer', async () => {
    const r = await deferThenResume({ tool: 'Read', id: READ_ID, input: { file_path: '/etc/hostname' } })
    expect(r.first.filter((l) => 'hook' in l)).toEqual([{ hook: READ_ID, defer: true }])
    expect(r.first.at(-1)).toMatchObject({ stop: 'tool_deferred', deferred: READ_ID })
    expect(r.stored, "the store holds the CLI's deferral record").toContain('"hook_deferred_tool"')
    expect(r.second.filter((l) => 'hook' in l)).toEqual([{ hook: READ_ID, defer: false }])
    expect(r.second.filter((l) => 'result' in l)).toEqual([{ result: 'answered', stop: 'end_turn', deferred: null }])
    expect(r.model.misses).toEqual([])
  }, 120_000)

  it('the control: a plain "" resume runs the call, then adds an empty turn of its own (a second model call and result)', async () => {
    const r = await deferThenResume({ tool: 'Read', id: READ_ID, input: { file_path: '/etc/hostname' }, plain: true })
    expect(r.second.filter((l) => 'hook' in l)).toEqual([{ hook: READ_ID, defer: false }])
    expect(r.second.filter((l) => 'result' in l).length).toBeGreaterThan(1)
    expect(r.model.misses.length).toBeGreaterThan(0)
  }, 120_000)

  it("an MCP call run again carries the CLI's _meta tool use id", async () => {
    const calls: unknown[] = []
    const mcp = await mcpServer(calls)
    try {
      const r = await deferThenResume({ tool: 'mcp__inhouse__question_ask', id: ASK_ID, input: { question: 'Which?' }, mcpUrl: `${mcp.url}/mcp/` })
      expect(r.first.at(-1)).toMatchObject({ stop: 'tool_deferred', deferred: ASK_ID })
      expect(r.second.filter((l) => 'hook' in l)).toEqual([{ hook: ASK_ID, defer: false }])
      expect(calls).toEqual([expect.objectContaining({ 'claudecode/toolUseId': ASK_ID })])
      expect(r.second.filter((l) => 'result' in l)).toEqual([{ result: 'answered', stop: 'end_turn', deferred: null }])
      expect(r.model.misses).toEqual([])
    } finally {
      mcp.close()
    }
  }, 120_000)
})
