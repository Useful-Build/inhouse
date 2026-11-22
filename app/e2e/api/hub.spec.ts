// The hub from the runner (P4 H1, W1; acceptance 4 and 5; p4-w6.md section 4). Four groups:
//   1. configs: the product Worker has exactly one hub binding, `ReadGateway`, in both the product and the test config
//      (a pure file check; the same rule `scripts/check-product-config.mjs` runs in CI);
//   2. the write refusal at the hub (5): a scripted turn sends a GraphQL mutation through `mcp__apps__fixture_query`, the
//      tool result is an error with `write_refused`, and the product Worker's and the hub's log lines say so;
//   3. no public route: the hub's default export answers 404 to every method;
//   4. the canary sweep (4): after the morning check ran, neither the upstream's access token nor the test client secret nor
//      a run token appears in either Worker's output, the runner container's log, a full D1 dump and every R2 object (both taken after the runs), the
//      runner's environment (a scripted `Bash` call printing `env` into a file read back here) or the run's events.
// The orchestrator starts the multi-config test build under the heavy lock and sets three switches (documented in watch-kit.ts):
// `E2E_WATCH_BUILD=1`; `E2E_HUB_ORIGIN`, the hub Worker's own origin; `WATCH_ARTIFACTS_DIR`, where it keeps the sweep's live
// inputs: product-wrangler.log, hub-wrangler.log, runner-container.log and run-tokens.txt (`<runId> <token>` per line; it must
// hold the two runs this spec makes) (`ARTIFACTS` below). The local D1 and R2 are dumped by the spec itself after its runs.
// Without E2E_WATCH_BUILD the container groups skip and say so on stderr; in a watch build a missing origin, directory or
// file fails: no check passes without its inputs.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { actor, call } from './kit.ts'
import { answerOf, createChat, send, textOf } from './chat-kit.ts'
import { dumpLocalD1, needsWatchBuild, readLocalR2, skipLoudly, slotWhere } from './watch-kit.ts'
import { leaks, withoutConfigEcho } from '../support/watch-pure.ts'
import { HUB_WRITE_REFUSED_ANSWER } from '../../test/scripted-model/scenarios.ts'

const dana = actor('memberA')
const admin = actor('admin')

const appFile = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8')

/**
 * What the orchestrator keeps under `WATCH_ARTIFACTS_DIR` while the build runs (names are the contract): the two Workers' output
 * and the runner container's log (streams, read as they are when the spec asks), and the run tokens the root proxy's test hook
 * captured, one `<runId> <token>` per line. The local D1 and R2 are not artifacts: the spec dumps them itself after its runs.
 */
const ARTIFACTS = { productLog: 'product-wrangler.log', hubLog: 'hub-wrangler.log', runnerLog: 'runner-container.log', runTokens: 'run-tokens.txt' } as const

const artifactsDir = process.env.WATCH_ARTIFACTS_DIR
const artifact = (name: string): string => {
  expect(artifactsDir, 'WATCH_ARTIFACTS_DIR is not set: a watch build must name where its logs and run tokens are kept').toBeTruthy()
  const path = join(artifactsDir!, name)
  expect(existsSync(path), `the orchestrator's artifact ${name} is missing from ${artifactsDir}: a sweep over nothing proves nothing`).toBe(true)
  return path
}
const textOfArtifact = (name: string): string => readFileSync(artifact(name), 'utf8')

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
  // P5 (#337 main merge): P4's one ReadGateway binding became P5's three. Each binding names the hub Worker and its own
  // entrypoint, once: HUB -> ReadGateway, HUB_CONNECT -> ConnectGateway and, where bound, HUB_DELIVERY -> DeliveryGateway.
  // Never ServerGateway (the runner's egress holds only HUB).
  const WANT: Record<string, string> = { HUB: 'ReadGateway', HUB_CONNECT: 'ConnectGateway', HUB_DELIVERY: 'DeliveryGateway' }
  for (const file of ['wrangler.product.jsonc', 'wrangler.test.jsonc']) {
    test(`${file} binds the hub once per entrypoint (ReadGateway, ConnectGateway, DeliveryGateway where bound), never ServerGateway`, () => {
      const text = appFile(file).split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      const entries = [...text.matchAll(/\{\s*"binding"\s*:\s*"([A-Z_]+)"\s*,\s*"service"\s*:\s*"([^"]+)"\s*,\s*"entrypoint"\s*:\s*"([A-Za-z]+)"\s*\}/g)]
        .map(m => ({ binding: m[1]!, service: m[2]!, entrypoint: m[3]! }))
      expect(entries.length, 'every hub binding read').toBe(text.match(/"service"\s*:/g)?.length ?? 0)
      for (const e of entries) {
        expect(e.service, e.binding).toBe('inhouse-hub')
        expect(WANT[e.binding], `${e.binding} is a hub binding`).toBeDefined()
        expect(e.entrypoint, e.binding).toBe(WANT[e.binding])
      }
      const named = (entrypoint: string) => entries.filter(e => e.entrypoint === entrypoint).length
      expect(named('ReadGateway'), 'one ReadGateway').toBe(1)
      expect(named('ConnectGateway'), 'one ConnectGateway').toBe(1)
      expect(named('DeliveryGateway'), 'at most one DeliveryGateway').toBeLessThanOrEqual(1)
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
    const egress = logLines(textOfArtifact(ARTIFACTS.productLog), 'egress_hub').filter(l => l.turnId === sent.turnId && l.method === 'tools/call')
    expect(egress.map(l => l.code), 'the product Worker logged one tools/call for the turn, refused').toEqual(['write_refused'])
    const hub = logLines(textOfArtifact(ARTIFACTS.hubLog), 'hub_call').filter(l => l.runId === sent.runId)
    expect(hub.map(l => [l.tool, l.code]), 'the hub logged the call with code write_refused, and nothing for it succeeded (the upstream keeps no request log: this line is the proof it never called out)').toEqual([['fixture_query', 'write_refused']])
  })
})

test.describe('the hub has no public route', () => {
  const origin = process.env.E2E_HUB_ORIGIN
  // Outside a watch build there is no hub port to ask (loud skip); in one, a missing E2E_HUB_ORIGIN fails.
  skipLoudly(!origin && process.env.E2E_WATCH_BUILD !== '1', 'no E2E_HUB_ORIGIN and no E2E_WATCH_BUILD: the orchestrator passes the hub Worker\'s own origin of the multi-config build')
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
    test(`${method} answers 404 on every path tried`, async ({ request }) => {
      expect(origin, 'E2E_HUB_ORIGIN must be set in a watch build').toBeTruthy()
      for (const path of ['/', '/mcp', '/hub/', '/rpc', '/api/health', '/admin/oauth/access_token', '/tools/call']) {
        const res = await request.fetch(`${origin}${path}`, { method, failOnStatusCode: false, maxRedirects: 0 })
        expect(res.status(), `${method} ${path}`).toBe(404)
      }
    })
  }
})

test.describe('no token or secret leaves the hub (acceptance 4: the canary sweep)', () => {
  needsWatchBuild()
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
    // The hook's file is `<runId> <token>` per line, and may hold other runs too, but must hold these two (the morning check's
    // and the env run's): the sweep looks for the tokens of the runs it just made, matched by run id, not for an older file's.
    const captured = new Map(textOfArtifact(ARTIFACTS.runTokens).split('\n').map(l => l.trim().split(/\s+/)).filter(p => p.length === 2).map(([id, token]) => [id!, token!]))
    for (const e of events) expect(captured.has(e.id), `run-tokens.txt holds run ${e.id}`).toBe(true)
    const needles: Record<string, string | RegExp> = { accessToken: /shpat_test_\d+/, clientSecret: secret! }
    for (const e of events) needles[`runToken of ${e.id}`] = captured.get(e.id)!
    // `wrangler dev` echoes a Worker's plain `vars` at start, and the hub's test config holds the invented test client secret as
    // one (its value is read from that file, and must be the upstream's). Only that echo line is dropped from the hub's output,
    // for exactly that name and value; the same value anywhere else in it is a leak.
    const configSecret = /"SHOPIFY_CLIENT_SECRET"\s*:\s*"([^"]+)"/.exec(appFile('wrangler.hub.test.jsonc'))?.[1]
    expect(configSecret, 'wrangler.hub.test.jsonc names the test client secret').toBe(secret)

    // The 401 and the refresh happened before the sweep reads the hub's output (no "the refresh path was swept" without it): the
    // hub logged a grant for the account (`signin_grant`, code ok) at two or more generations, the second being the refresh the
    // upstream's one 401 (armed in hub/testing/index.ts) forced. The log is the whole run of this hub, so an earlier read counts.
    const hubText = textOfArtifact(ARTIFACTS.hubLog)
    const grants = logLines(hubText, 'signin_grant').filter(l => l.code === 'ok')
    expect(new Set(grants.map(l => l.generation)).size, 'the hub granted a token and then refreshed it: two generations at least').toBeGreaterThanOrEqual(2)
    expect(logLines(hubText, 'hub_call').some(l => l.code === 'ok'), 'and its reads then succeeded').toBe(true)

    // The local D1 and R2 are dumped here, after this spec's own runs, not collected earlier.
    const r2 = readLocalR2()
    expect(r2.length, 'the local R2 holds objects (transcripts included)').toBeGreaterThan(0)
    const swept: { where: string; text: string }[] = [
      { where: 'product Worker output', text: textOfArtifact(ARTIFACTS.productLog) },
      { where: 'hub Worker output (without wrangler\'s echo of its own config var)', text: withoutConfigEcho(hubText, 'SHOPIFY_CLIENT_SECRET', configSecret!) },
      { where: 'runner container log', text: textOfArtifact(ARTIFACTS.runnerLog) },
      { where: 'local D1 dump (taken after the runs)', text: dumpLocalD1() },
      { where: 'the runner\'s environment (outputs/env.txt)', text: envText },
      ...events.map(e => ({ where: `events of run ${e.id}`, text: e.text })),
      ...r2.map(f => ({ where: `R2 object ${f.path}`, text: f.text })),
    ]
    for (const s of swept) expect(leaks(s.text, needles), `found in the ${s.where}`).toEqual([])
  })
})
