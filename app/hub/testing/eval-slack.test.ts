// The eval Slack workspace's source rules (Stage 1 M3, N31): it holds nothing and reaches nothing, and only the seam
// reads it. Ways it could fail, written down first:
//  1. the module reaches the network (`fetch(`, a socket) or reads any binding but the eval D1 (a token key, a client
//     secret, a SignIn object);
//  2. it imports anything (a connector, the SignIn objects, an upstream), so its reach grows without this test noticing;
//  3. something outside the seam imports it (the deployable graph could then reach it), or the seam stops switching it
//     on by the eval hub's env alone.
// Its behaviour on a real D1 is server/outbox/eval-slack.test.ts's; the hub path on workerd is eval-slack.eval.workers.test.ts's.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EVAL_SLACK_CANARY } from './eval-slack'

const hub = join(import.meta.dirname, '..')
const src = (rel: string): string => readFileSync(join(import.meta.dirname, rel), 'utf8')
const code = (text: string) => text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

describe('the eval Slack workspace holds nothing and reaches nothing (failures 1 and 2)', () => {
  const mod = code(src('./eval-slack.ts'))
  it('makes no outside request', () => {
    for (const needle of ['fetch(', 'fetch,', 'connect(', 'WebSocket', 'XMLHttpRequest', 'import(']) expect(mod).not.toContain(needle)
  })
  it('reads no binding but EVAL_WRITE_LOG, and names no credential', () => {
    expect([...mod.matchAll(/env\??\.([A-Za-z_]+)/g)].map(m => m[1])).toEqual(['EVAL_WRITE_LOG'])
    expect(mod).not.toMatch(/secret|token|password|signin|api_?key|client_?id|authorization|bearer/i)
  })
  it('imports nothing', () => {
    expect([...mod.matchAll(/\bfrom\s+'([^']+)'/g)]).toEqual([])
    expect(mod).not.toMatch(/\bimport\s/)
  })
  it('reads only its two tables, and writes none', () => {
    expect([...mod.matchAll(/FROM (\w+)/g)].map(m => m[1]).sort()).toEqual(['eval_slack_channel', 'eval_slack_message'])
    expect(mod).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)\b/i)
  })
  it('the canary is the value check-hub-build.mjs reads', () => {
    expect(EVAL_SLACK_CANARY).toBe('INHOUSE_EVAL_SLACK_CANARY_5d1e')
  })
})

describe('only the seam reads it (failure 3)', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.name === 'node_modules' ? [] : d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)])
  it('no hub module outside hub/testing/ imports it, and in hub/testing/ only the seam (and the tests)', () => {
    const importers = walk(hub)
      .filter(f => /\.ts$/.test(f) && !/\.test\.ts$/.test(f))
      .filter(f => /from '[./]*(?:testing\/)?eval-slack'/.test(readFileSync(f, 'utf8')))
      .map(f => relative(hub, f))
    expect(importers).toEqual(['testing/index.ts'])
  })
  it('the seam serves the eval workspace to the Slack fake from the env it is given, and only for the Slack MCP host', () => {
    const seam = code(src('./index.ts'))
    expect(seam).toContain("if (host === 'mcp.slack.com') slackMcp.workspace = await evalSlackWorkspace(env as (Env & EvalSlackEnv) | undefined)")
    expect(seam.match(/evalSlackWorkspace\(/g)).toHaveLength(1)
  })
  it('the singleton test-fakes DO passes the hub\'s env to the seam, inside the test build\'s guard', () => {
    const signin = code(src('../signin/signin.ts'))
    expect(signin).toContain('return await testUpstreamFetch(request, this.env)')
  })
})
