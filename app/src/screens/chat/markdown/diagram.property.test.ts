// @vitest-environment jsdom
// What must hold for any text with or without mermaid fences while it is live. Ways it could break, written first: a
// half-written fence, a fence of the wrong length or mark, a diagram inside a quote or list, or plain noise next to a fence
// makes the renderer throw (the chat stops mid-answer); a diagram shows an error box before its fence has closed; a finished
// diagram renders differently live and done; a diagram is counted as a code block.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { fc, test } from '@fast-check/vitest'
import { afterAll, beforeAll, expect, vi } from 'vitest'
import { endsInOpenFence } from './policy'
import { Markdown } from './renderer'

vi.mock('../../../ui', () => ({ IconButton: () => null }))
vi.mock('../copy', () => ({ copyText: () => undefined }))
// The worst engine: every draw fails. So a diagram that is drawn at all shows "Couldn't draw", and one held back does not.
vi.mock('./diagram-engine', () => ({ drawDiagram: () => Promise.reject(new Error('Parse error')) }))

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// Each failed draw is logged (diagram.tsx); here they are expected.
beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined) })
afterAll(() => { vi.restoreAllMocks() })

const render = (text: string, live: boolean) => renderToStaticMarkup(createElement(Markdown, { text, live }))

const line = fc.oneof(
  fc.stringMatching(/^[a-zA-Z0-9 \-[\]{}()>|:;,."'`~*#_<]{0,30}$/), fc.string({ maxLength: 20 }),
  fc.constantFrom(
    '```mermaid', '~~~mermaid', '````mermaid', '```', '~~~', '````', '```sql', '> ```mermaid', '- ```mermaid', '  ```mermaid',
    'flowchart LR', '  A[Start] --> B{Ok}', '  B -->|Yes| C[Done]', 'sequenceDiagram', 'A->>B: hi', '```mermaid title="x"', '',
  ),
)
const text = fc.array(line, { maxLength: 14 }).map(a => a.join('\n'))
const prefixes = (s: string, n = 20) => Array.from({ length: Math.min(n, s.length) }, (_, i) => s.slice(0, Math.ceil(((i + 1) * s.length) / n))).concat(s)

test.prop([text], { numRuns: 80 })('any text, with or without mermaid fences, renders without throwing while it is live, at every point of the stream, and a diagram whose fence is still open waits', async t => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    for (const p of prefixes(t)) {
      // With effects, so a draw runs (and fails) wherever the renderer lets it.
      await act(async () => root.render(createElement(Markdown, { text: p, live: true })))
      await act(async () => { await new Promise(r => setTimeout(r, 0)) })
      // Code blocks and diagrams, not the source block inside a diagram that failed.
      const blocks = [...host.querySelectorAll('[data-md-diagram], [data-md-code]')].filter(b => !b.parentElement?.closest('[data-md-diagram]'))
      const lastBlock = blocks.at(-1)
      // The last block is a diagram still being written: it never draws, so never shows an error, and never shows a figure.
      if (endsInOpenFence(p) && lastBlock?.hasAttribute('data-md-diagram')) expect(lastBlock.getAttribute('data-state'), p).toBe('drawing')
      // A diagram never shows a figure from a failed draw.
      expect(host.querySelector('[data-md-diagram] svg')).toBeNull()
    }
  } finally {
    act(() => root.unmount())
  }
})

const body = fc.array(fc.constantFrom('flowchart LR', '  A[Start] --> B[End]', 'sequenceDiagram', '  A->>B: hi', 'not a diagram'), { minLength: 1, maxLength: 4 })
test.prop([fc.array(body, { minLength: 1, maxLength: 3 })], { numRuns: 40 })('closed diagrams render the same live as done, and each one is counted as a diagram, not a code block', bodies => {
  const t = bodies.map(b => ['```mermaid', ...b, '```'].join('\n')).join('\n\n') + '\n'
  expect(render(t, true)).toBe(render(t, false))
  expect([...render(t, false).matchAll(/data-md-diagram/g)]).toHaveLength(bodies.length)
  expect(render(t, false)).not.toContain('data-md-code')
})
