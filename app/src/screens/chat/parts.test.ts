import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test, vi } from 'vitest'
import { AgentPart } from './Parts'

vi.mock('../../state/store', () => ({
  useCtx: () => ({ agent: { settings: { 't:webfetch': 'api.example.test\ndocs.example.test' } } }),
  useUi: () => undefined,
}))
vi.mock('../../ui/chat', () => ({ SuggestionChip: () => null }))

test('AgentPart enables links to WebFetch hosts only after streaming ends', () => {
  const text = '[Listed](https://docs.example.test/guide) [Unlisted](https://other.example.test/guide) [HTTP](http://docs.example.test/guide)'
  const render = (streaming: boolean) => renderToStaticMarkup(createElement(AgentPart, {
    part: { type: 'text', text },
    id: 'answer',
    trace: 'trace',
    streaming,
  }))

  const partial = render(true)
  expect(partial).not.toMatch(/<a\b/)
  expect(partial).toContain('>Listed Unlisted HTTP</p>')

  const complete = render(false)
  expect(complete.match(/<a\b/g)).toHaveLength(1)
  expect(complete).toContain('href="https://docs.example.test/guide"')
  expect(complete).toContain('>Listed</a> Unlisted HTTP</p>')
})
