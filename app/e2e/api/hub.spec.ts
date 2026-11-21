// The hub from the runner (P4 H1, W1; acceptance 4 and 5; p4-w6.md section 4). Four groups:
//   1. configs: the product Worker has exactly one hub binding, `ReadGateway`, in both the product and the test config
//      (a pure file check; the same rule `scripts/check-product-config.mjs` runs in CI);
//   2. the write refusal at the hub (5): a scripted turn sends a GraphQL mutation through `mcp__apps__fixture_query`, the
//      tool result is an error with `write_refused`, and the product Worker's and the hub's log lines say so;
//   3. no public route: the hub's default export answers 404 to every method;
//   4. the canary sweep (4): after the morning check ran, neither the upstream's access token nor the test client secret nor
//      a run token appears in either Worker's output, the runner container's log, a full D1 dump, every R2 object, the
//      runner's environment (a scripted `Bash` call printing `env` into a file read back here) or the run's events.
// The orchestrator starts the multi-config test build under the heavy lock and sets three switches (documented in watch-kit.ts):
// `E2E_WATCH_BUILD=1`; `E2E_HUB_ORIGIN`, the hub Worker's own origin; `WATCH_ARTIFACTS_DIR`, where it collects the sweep's
// inputs: product-wrangler.log, hub-wrangler.log, runner-container.log, d1-dump.sql, r2/ (every object) and run-tokens.txt
// (`ARTIFACTS` below). A group whose switch is missing skips and says so on stderr; an input that is named but missing fails
// loud: a sweep over nothing proves nothing.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { actor, call } from './kit.ts'
import { answerOf, createChat, send, textOf } from './chat-kit.ts'
import { needsWatchBuild, skipLoudly, slotWhere } from './watch-kit.ts'
import { leaks, withoutConfigEcho } from '../support/watch-pure.ts'
import { HUB_WRITE_REFUSED_ANSWER } from '../../test/scripted-model/scenarios.ts'

const dana = actor('memberA')
const admin = actor('admin')

const appFile = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

/** What the orchestrator drops under `WATCH_ARTIFACTS_DIR` after the build has run the morning check (names are the contract). */
const ARTIFACTS = {
  productLog: 'product-wrangler.log',
  hubLog: 'hub-wrangler.log',
  runnerLog: 'runner-container.log',
  d1Dump: 'd1-dump.sql',
  r2Dir: 'r2',
  runTokens: 'run-tokens.txt',
} as const

const artifactsDir = process.env.WATCH_ARTIFACTS_DIR
const artifact = (name: string): string => {
  const path = join(artifactsDir!, name)
  expect(existsSync(path), `the orchestrator's artifact ${name} is missing from ${artifactsDir}: a sweep over nothing proves nothing`).toBe(true)
  return path
}
const textOfArtifact = (name: string): string => readFileSync(artifact(name), 'utf8')
/** Every file under a directory, as text where it is valid UTF-8 and as latin1 bytes otherwise (a needle is ASCII either way). */
function filesUnder(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => {
    const path = join(d.parentPath, d.name)
    return { path, text: readFileSync(path).toString('latin1') }
  })
}

/** The JSON log lines of a Worker's output with `event` as given (a line may carry a prefix before its `{`). */
function logLines(text: string, event: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const at = line.indexOf('{')
    if (at < 0 || !line.includes(`"event":"${event}"`)) continue
    try { out.push(JSON.parse(line.slice(at)) as Record<string, unknown>) } catch { /* a line that only mentions the event */ }
  }
  return out
}

test.describe('the product Worker\'s hub binding', () => {
  for (const file of ['wrangler.product.jsonc', 'wrangler.test.jsonc']) {
    test(`${file} binds the hub once, as ReadGateway, and never ServerGateway`, () => {
      const text = appFile(file).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(text.match(/"service"\s*:\s*"inhouse-hub"/g), 'one binding to the hub Worker').toHaveLength(1)
      expect(text.match(/"entrypoint"\s*:\s*"ReadGateway"/g), 'its entrypoint is ReadGateway').toHaveLength(1)
      expect(text).not.toContain('ServerGateway')
    })
  }
})

test.describe('a write sent through the runner\'s scope is refused at the hub (acceptance 5)', () => {
  needsWatchBuild()
  test.describe.configure({ timeout: 600_000 })

  test('a scripted turn\'s mutation document comes back as an error with write_refused, and the logs say so', async ({ request }) => {
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, 'scenario:hub-write-refused please cancel an order')
    // The scenario answers HUB_WRITE_REFUSED_ANSWER only when the tool result held `write_refused` and was flagged as an error.
    expect(textOf(await answerOf(request, dana, chat, sent.turnId))).toContain(HUB_WRITE_REFUSED_ANSWER)
    if (!artifactsDir) {
      test.info().annotations.push({ type: 'note', description: 'no WATCH_ARTIFACTS_DIR: the log lines are proven where the orchestrator collects the Workers\' output' })
      return
    }
    const egress = logLines(textOfArtifact(ARTIFACTS.productLog), 'egress_hub').filter(l => l.turnId === sent.turnId && l.method === 'tools/call')
    expect(egress.map(l => l.code), 'the product Worker logged one tools/call for the turn, refused').toEqual(['write_refused'])
    const hub = logLines(textOfArtifact(ARTIFACTS.hubLog), 'hub_call').filter(l => l.runId === sent.runId)
    expect(hub.map(l => [l.tool, l.code]), 'the hub logged the call with code write_refused, and nothing for it succeeded (the upstream keeps no request log: this line is the proof it never called out)').toEqual([['fixture_query', 'write_refused']])
  })
})

test.describe('the hub has no public route', () => {
  const origin = process.env.E2E_HUB_ORIGIN
  skipLoudly(!origin, 'no E2E_HUB_ORIGIN: the orchestrator passes the hub Worker\'s own port of the multi-config build')
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    test(`${method} answers 404 on every path tried`, async ({ request }) => {
      for (const path of ['/', '/mcp', '/hub/', '/rpc', '/api/health', '/admin/oauth/access_token', '/tools/call']) {
        const res = await request.fetch(`${origin}${path}`, { method, failOnStatusCode: false, maxRedirects: 0 })
        expect(res.status(), `${method} ${path}`).toBe(404)
      }
    })
  }
})

test.describe('no token or secret leaves the hub (acceptance 4: the canary sweep)', () => {
  needsWatchBuild()
  skipLoudly(!artifactsDir, 'no WATCH_ARTIFACTS_DIR: the orchestrator collects the artifacts and passes the directory')
  test.describe.configure({ timeout: 900_000 })

  test('after the morning check ran: the access token, the client secret and the run tokens appear nowhere', async ({ request }) => {
    // S1: the morning check, Run now, to its end. It reads the store through the hub, so the hub holds a token by now.
    const key = crypto.randomUUID().replaceAll('-', '')
    const run = await call(request, dana, 'POST', '/api/routines/routine-morning-check/run', { json: { clientKey: key } })
    expect(run.status, run.text).toBe(200)
    const slot = await slotWhere('routine-morning-check', 'the morning check\'s manual slot to end', s => s.slot_key === `now|routine-morning-check|${key}` && s.state === 'ended', 600_000)
    expect(slot.failure, 'the morning check ran clean, so the hub path (refresh included) was exercised').toBeNull()

    // The runner's environment: a scripted Bash call prints `env` into outputs/env.txt, read back through the files route.
    const chat = await createChat(request, dana)
    const env = await send(request, dana, chat, 'scenario:env-to-file print the environment')
    await answerOf(request, dana, chat, env.turnId)
    const files = await call(request, dana, 'GET', `/api/chats/${chat}/files`)
    const envFile = (files.json.items as { fileId: string; kind: string; name: string }[]).find(f => f.kind === 'output' && f.name === 'env.txt')
    expect(envFile, 'the turn saved outputs/env.txt').toBeTruthy()
    const envText = (await call(request, dana, 'GET', `/api/files/${envFile!.fileId}`)).text
    expect(envText.length, 'the environment file has content').toBeGreaterThan(0)

    // The run's events: the trace route's text for the morning check's run and for the env run.
    const events = [slot.run_id, env.runId].map(id => ({ id: id!, text: '' }))
    for (const e of events) {
      const r = await call(request, admin, 'GET', `/api/traces/${e.id}`)
      expect(r.status, r.text).toBe(200)
      e.text = r.text
    }

    // What to look for: every access token the recorded upstream issues is `shpat_test_<n>` (its sequence number), the client
    // secret is the test-only one in the hub's test config, and the run tokens the root proxy's test hook captured.
    const secret = /export const TEST_CLIENT_SECRET = '([^']+)'/.exec(appFile('test/upstreams/shopify/server.ts'))?.[1]
    expect(secret, 'the upstream\'s test client secret is in test/upstreams/shopify/server.ts').toBeTruthy()
    const runTokens = textOfArtifact(ARTIFACTS.runTokens).split('\n').map(l => l.trim()).filter(Boolean)
    expect(runTokens.length, 'the root proxy hook captured the runs\' tokens').toBeGreaterThan(0)
    const needles: Record<string, string | RegExp> = { accessToken: /shpat_test_\d+/, clientSecret: secret! }
    // `wrangler dev` echoes a Worker's plain `vars` at start, and the hub's test config holds the invented test client secret as
    // one (its value is read from that file, and must be the upstream's). Only that echo line is dropped from the hub's output,
    // for exactly that name and value; the same value anywhere else in it is a leak.
    const configSecret = /"SHOPIFY_CLIENT_SECRET"\s*:\s*"([^"]+)"/.exec(appFile('wrangler.hub.test.jsonc'))?.[1]
    expect(configSecret, 'wrangler.hub.test.jsonc names the test client secret').toBe(secret)
    runTokens.forEach((t, i) => { needles[`runToken${i}`] = t })

    const swept: { where: string; text: string }[] = [
      { where: 'product Worker output', text: textOfArtifact(ARTIFACTS.productLog) },
      { where: 'hub Worker output (without wrangler\'s echo of its own config var)', text: withoutConfigEcho(textOfArtifact(ARTIFACTS.hubLog), 'SHOPIFY_CLIENT_SECRET', configSecret!) },
      { where: 'runner container log', text: textOfArtifact(ARTIFACTS.runnerLog) },
      { where: 'local D1 dump', text: textOfArtifact(ARTIFACTS.d1Dump) },
      { where: 'the runner\'s environment (outputs/env.txt)', text: envText },
      ...events.map(e => ({ where: `events of run ${e.id}`, text: e.text })),
      ...filesUnder(artifact(ARTIFACTS.r2Dir)).map(f => ({ where: `R2 object ${f.path}`, text: f.text })),
    ]
    expect(statSync(artifact(ARTIFACTS.r2Dir)).isDirectory()).toBe(true)
    expect(swept.filter(s => s.where.startsWith('R2 object')).length, 'the R2 dump holds objects (transcripts included)').toBeGreaterThan(0)
    for (const s of swept) expect(leaks(s.text, needles), `found in the ${s.where}`).toEqual([])
  })
})
