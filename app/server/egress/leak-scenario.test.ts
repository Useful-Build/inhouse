// The `webfetch-leak` scripted scenario's last check (M1-G's scenario; M1-P's sandbox run showed what the real CLI 2.1.328
// sends). Ways it can fail: the CLI's plain 403 result for the refused fetch is a miss (the sandbox spec then fails on
// a refusal that worked), or a leak fetch that went out (a page summary) passes as a refusal, or another refusal passes.
import { describe, expect, it } from 'vitest'
import { createScriptedModel } from '../../test/scripted-model/index.ts'
import { LEAK_CHECK_SCENARIOS } from '../../test/scripted-model/scenarios/leak-check.ts'

const call = (id: string, url: string) => ({ type: 'tool_use', id, name: 'WebFetch', input: { url, prompt: 'p' } })
const result = (id: string, content: string, isError?: boolean) =>
  ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] })

/** Turn 3's request: the read, the control and the leak fetch, the last one answered `leak`. */
const turn3 = (leak: { content: string; isError?: boolean }) => ({
  model: 'claude-sonnet-5-5', stream: false, tools: [{ name: 'WebFetch' }],
  messages: [
    { role: 'user', content: 'scenario:webfetch-leak go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_scripted_leak_read', name: 'mcp__apps__order_get', input: {} }] },
    result('toolu_scripted_leak_read', '{"name":"#1001"}'),
    { role: 'assistant', content: [call('toolu_scripted_leak_control', 'https://example.com/?ref=leak-check-control')] },
    result('toolu_scripted_leak_control', 'A page kept for documentation examples.'),
    { role: 'assistant', content: [call('toolu_scripted_leak_fetch', 'https://example.com/?order=%231001')] },
    result('toolu_scripted_leak_fetch', leak.content, leak.isError),
  ],
})
const answer = async (leak: { content: string; isError?: boolean }) => {
  const m = createScriptedModel(LEAK_CHECK_SCENARIOS)
  const res = await m.handle(new Request('http://proxy/model/v1/messages', { method: 'POST', body: JSON.stringify(turn3(leak)) }), 'webfetch-leak')
  return { status: res.status, misses: m.misses.map(x => x.reason) }
}

describe('webfetch-leak: the refused fetch', () => {
  it("passes on the CLI 2.1.328's plain 403 result, the refusal's own words, or a 403 error", async () => {
    for (const leak of [
      { content: 'The server returned HTTP 403 Forbidden. The response body was not retrieved. If this URL requires authentication, use an authenticated tool instead of WebFetch.' },
      { content: 'WebFetch refused: leak', isError: true },
      { content: 'Request failed with status code 403', isError: true },
    ]) expect(await answer(leak), leak.content).toEqual({ status: 200, misses: [] })
  })
  it('misses on a page that went out, another refusal or another status', async () => {
    for (const leak of [
      { content: 'A page kept for documentation examples.' },
      { content: 'The server returned HTTP 404 Not Found. The response body was not retrieved.' },
      { content: 'WebFetch refused: host', isError: true },
      { content: 'Request failed with status code 500', isError: true },
    ]) expect((await answer(leak)).status, leak.content).toBe(400)
  })
})
