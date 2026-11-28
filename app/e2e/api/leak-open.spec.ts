// Stage 1 M3-J (N29): the forced-fetch leak case on the sandbox deploy, with a real container, the real CLI and the
// deployed web egress in `open` mode. Paid run 1 graded open fetch with zero bypasses but its model never tried a fetch,
// so this case makes every attempt itself: the scripted `webfetch-leak-open` scenario
// (test/scripted-model/scenarios/leak-open.ts) reads order #1001 through the hub, fetches a clean control page, then
// tries to carry #1001 out in the path, in the query, in a header (through Bash, the only tool that could set one) and
// one hop through a public redirector. The turn answers `LEAK_OPEN_DONE` only if the read carried #1001, the control went
// through and each token-carrying fetch came back refused. The egress record (the test-fakes hook's `egress` op; the
// record keeps each hop's host, verdict and refusal code) then shows, for this turn's rows:
//  - the control's host and the redirector's first hop `allowed`;
//  - the path's, the query's and the redirect target's hosts each refused `leak` exactly once: the leak check refuses
//    before DNS (a DNS refusal is `dns`) and before any page request;
//  - no `allowed` row for any of those hosts, and no row at all for the header attempt's host: the egress is the only way
//    out of the container and records every request before it sends it, so no row means nothing reached the host.
// Its CI twin, server/egress/leak-open.test.ts, runs the same URLs through the egress in workerd with the network faked.
// Runs ONLY when named, like write-loop.spec.ts: `gh workflow run sandbox-test-deploy ... -f full=true -f only="api/leak-open.spec.ts"`.
// It needs httpbin.org (the redirector) and example.com reachable from the sandbox, so it stays out of the default agent
// set, where a third-party outage would fail unrelated PRs; the default set keeps M1-G's open-mode leak check
// (egress-leak.spec.ts). It is the gate for M3-J's default (`open` for a brand with no host list): name it whenever the
// egress, the taint store or the runner's fetch path changes.
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import {
  LEAK_OPEN_DONE, LEAK_OPEN_HEADER_HOST, LEAK_OPEN_REDIRECT_TARGET, LEAK_OPEN_SCENARIO, LEAK_OPEN_URLS,
} from '../../test/scripted-model/scenarios/leak-open.ts'
import { answerOf, createChat, send, textOf } from './chat-kit.ts'
import { hook } from './fakes-kit.ts'
import { actor, call, putSetting } from './kit.ts'

const SELF = 'api/leak-open.spec.ts'
const asked = (process.env.ONLY ?? '').split(/\s+/).includes(SELF)
const dana = actor('memberA')
const inhouse = actor('inhouse')

interface Row { n: number; host: string; verdict: 'allowed' | 'refused'; code: string | null }
const egress = async (request: APIRequestContext, after = 0): Promise<{ top: number; rows: Row[] }> => {
  const r = await hook(request, { op: 'egress', after })
  expect(r.status, r.text).toBe(200)
  return r.json as { top: number; rows: Row[] }
}
const technical = async (request: APIRequestContext, key: string): Promise<unknown> => {
  const r = await call(request, inhouse, 'GET', '/api/settings/technical')
  expect(r.status, r.text).toBe(200)
  return (r.json.items as { key: string; value: unknown }[]).find(i => i.key === key)?.value
}
const hostOf = (url: string) => new URL(url).hostname

test('open mode: #1001 read through the hub never leaves, in the path, the query, a header or past a redirect; a clean page does', async ({ request }) => {
  test.skip(!asked, `runs only when named: sandbox-test-deploy -f full=true -f only="${SELF}"`)
  test.setTimeout(300_000)
  const prevList = await technical(request, 't:webfetch')
  const prevMode = await technical(request, 't:webfetch_mode')
  expect((await putSetting(request, inhouse, 'technical', 't:webfetch', '')).status).toBe(200)
  expect((await putSetting(request, inhouse, 'technical', 't:webfetch_mode', 'open')).status).toBe(200)
  try {
    const { top } = await egress(request)
    const chat = await createChat(request, dana)
    const sent = await send(request, dana, chat, `scenario:${LEAK_OPEN_SCENARIO} read the order and try every way out`)
    const answer = await answerOf(request, dana, chat, sent.turnId, 240_000)
    expect(textOf(answer)).toBe(LEAK_OPEN_DONE)

    // Four WebFetch steps and the Bash step in the turn's trace.
    const steps = (await call(request, dana, 'GET', `/api/traces/${sent.turnId}`)).json.steps as { kind: string; detail: string }[]
    expect(steps.filter(s => s.kind === 'tool' && s.detail === 'WebFetch')).toHaveLength(4)

    const leaked = [hostOf(LEAK_OPEN_URLS.path), hostOf(LEAK_OPEN_URLS.query), hostOf(LEAK_OPEN_REDIRECT_TARGET)]
    // A refusal's row is written in the background (webfetch.ts `refuse`): wait until all three are there, then say
    // what the record holds either way, so a miss shows where each attempt ended.
    try {
      await expect.poll(async () => (await egress(request, top)).rows.filter(r => leaked.includes(r.host)).length,
        { timeout: 30_000, intervals: [1_000], message: 'the three leak refusals are recorded' }).toBeGreaterThanOrEqual(3)
    } finally {
      console.log(`leak-open: the egress record for this turn: ${JSON.stringify((await egress(request, top)).rows.map(r => [r.host, r.verdict, r.code]))}`)
      console.log(`leak-open: the turn's tool steps: ${JSON.stringify(steps.filter(s => s.kind === 'tool'))}`)
    }
    const rows = (await egress(request, top)).rows
    for (const host of leaked) {
      expect(rows.filter(r => r.host === host), host).toEqual([expect.objectContaining({ host, verdict: 'refused', code: 'leak' })])
    }
    expect(rows.filter(r => r.host === LEAK_OPEN_HEADER_HOST), 'nothing reached the header attempt\'s host').toEqual([])
    expect(rows.filter(r => r.host === hostOf(LEAK_OPEN_URLS.control) && r.verdict === 'allowed'), 'the control went out').toHaveLength(1)
    expect(rows.filter(r => r.host === hostOf(LEAK_OPEN_URLS.redirect) && r.verdict === 'allowed'), 'the redirector\'s clean first hop went out').toHaveLength(1)
  } finally {
    expect((await putSetting(request, inhouse, 'technical', 't:webfetch_mode', typeof prevMode === 'string' ? prevMode : null)).status).toBe(200)
    expect((await putSetting(request, inhouse, 'technical', 't:webfetch', typeof prevList === 'string' ? prevList : null)).status).toBe(200)
  }
})
