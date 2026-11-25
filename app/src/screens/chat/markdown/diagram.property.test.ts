// What must hold for any text with or without mermaid fences while it is live. Ways it could break, written first: a
// half-written fence, a fence of the wrong length or mark, a diagram inside a quote or list, or plain noise next to a fence
// makes the renderer throw (the chat stops mid-answer); a diagram shows an error box before its fence has closed; a finished
// diagram renders differently live and done; a diagram is counted as a code block.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { fc, test } from '@fast-check/vitest'
import { expect, vi } from 'vitest'
import { Markdown } from './renderer'

vi.mock('../../../ui', () => ({ IconButton: () => null }))
vi.mock('../copy', () => ({ copyText: () => undefined }))

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

test.prop([text], { numRuns: 80 })('any text, with or without mermaid fences, renders without throwing while it is live, at every point of the stream', t => {
  for (const p of prefixes(t)) {
    const html = render(p, true)
    // A half-written diagram never shows an error: only a diagram that fails after it closed can, and that happens in the browser.
    expect(html).not.toMatch(/Couldn.t draw this diagram/)
    // The figure is drawn only in the browser, so no markup of one is here.
    expect(html).not.toContain('<svg')
  }
})

const body = fc.array(fc.constantFrom('flowchart LR', '  A[Start] --> B[End]', 'sequenceDiagram', '  A->>B: hi', 'not a diagram'), { minLength: 1, maxLength: 4 })
test.prop([fc.array(body, { minLength: 1, maxLength: 3 })], { numRuns: 40 })('closed diagrams render the same live as done, and each one is counted as a diagram, not a code block', bodies => {
  const t = bodies.map(b => ['```mermaid', ...b, '```'].join('\n')).join('\n\n') + '\n'
  expect(render(t, true)).toBe(render(t, false))
  expect([...render(t, false).matchAll(/data-md-diagram/g)]).toHaveLength(bodies.length)
  expect(render(t, false)).not.toContain('data-md-code')
})
