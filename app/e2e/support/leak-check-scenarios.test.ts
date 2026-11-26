// The scripted fetch leak check scenario (test/scripted-model/scenarios/leak-check.ts) the M1-G spec relies on
// (e2e/api/egress-leak.spec.ts). It only runs in a container on the deployed test build, so how its last turn reads the
// leak fetch's result is proved here, against the scripted model itself. Ways it could fail, written first:
//  - CLI 2.1.328 answers the egress's 403 as a plain result in its own words (no `is_error`), and the turn misses on it
//    (seen on the sandbox for PRs 441 and 444);
//  - a fetch that went out (a page summary), another refusal or another status passes as the leak refusal.
import { describe, expect, test } from 'vitest'
import { createScriptedModel } from '../../test/scripted-model/index.ts'
import { HARNESS_MODEL, SCENARIOS } from '../../test/scripted-model/scenarios.ts'
import { LEAK_CONTROL_URL, LEAK_ORDER_NAME, LEAK_URL, WEBFETCH_LEAK_REFUSED_ANSWER } from '../../test/scripted-model/scenarios/leak-check.ts'

const SCENARIO = 'webfetch-leak'
const CLI_403 = 'The server returned HTTP 403 Forbidden. The response body was not retrieved. If this URL requires authentication, use an authenticated tool (e.g. `gh` for GitHub, or an MCP-provided fetch tool) instead of WebFetch.'

/** The main-loop request after the read, the control fetch and the leak fetch, the last answered by `leak`. */
function request(leak: { text: string; error?: boolean }) {
  const calls = [
    { id: 'toolu_scripted_leak_read', name: 'mcp__apps__order_get', input: { name: LEAK_ORDER_NAME }, text: `{"name":"${LEAK_ORDER_NAME}"}` },
    { id: 'toolu_scripted_leak_control', name: 'WebFetch', input: { url: LEAK_CONTROL_URL }, text: 'A page kept for documentation examples.' },
    { id: 'toolu_scripted_leak_fetch', name: 'WebFetch', input: { url: LEAK_URL }, text: leak.text, error: leak.error },
  ]
  const messages: unknown[] = [{ role: 'user', content: `scenario:${SCENARIO} read order and check page` }]
  for (const c of calls) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: c.id, name: c.name, input: c.input }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: c.id, content: c.text, ...(c.error ? { is_error: true } : {}) }] })
  }
  return new Request('http://scripted.invalid/v1/messages', {
    method: 'POST',
    body: JSON.stringify({ model: HARNESS_MODEL, tools: [{ name: 'WebFetch' }, { name: 'mcp__apps__order_get' }], messages }),
  })
}
const status = async (leak: { text: string; error?: boolean }): Promise<{ status: number; body: string }> => {
  const res = await createScriptedModel(SCENARIOS).handle(request(leak), SCENARIO)
  return { status: res.status, body: await res.text() }
}

describe('the M1-G fetch leak scenario', () => {
  test('the last turn answers the leak refusal: the egress body, a 403 error, or CLI 2.1.328\'s plain 403 words', async () => {
    for (const leak of [
      { text: 'WebFetch refused: leak', error: true },
      { text: 'Request failed with status code 403', error: true },
      { text: CLI_403 },
    ]) {
      const r = await status(leak)
      expect(r.status, JSON.stringify(leak)).toBe(200)
      expect(r.body).toContain(WEBFETCH_LEAK_REFUSED_ANSWER)
    }
  })

  test('it misses on a page that went out, another refusal, another status, or the 403 words marked as an error', async () => {
    for (const leak of [
      { text: 'A page kept for documentation examples.' },
      { text: 'WebFetch refused: not_listed', error: true },
      { text: 'Request failed with status code 404', error: true },
      { text: 'The server returned HTTP 404 Not Found. The response body was not retrieved.' },
      { text: `Note: ${CLI_403}` },
      { text: CLI_403, error: true },
    ]) {
      const r = await status(leak)
      expect(r.status, JSON.stringify(leak)).toBe(400)
    }
  })
})
