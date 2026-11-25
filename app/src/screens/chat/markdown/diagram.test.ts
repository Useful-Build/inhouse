// Mermaid diagrams in an answer. Ways they could break, written first: a text with no diagram loads Mermaid (the weight
// leaks into every chat: engine test); a fence is not seen as a diagram (```mermaid, ~~~mermaid) or a lookalike is
// (```mermaidx); a diagram takes a code block's number; a half-written fence draws or errors mid-stream; a diagram that
// can't be drawn shows nothing instead of its source; Mermaid runs with a looser mode than strict, or with HTML labels; a
// token is missing and the colours come out wrong without a word.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { Markdown } from './renderer'
import { DiagramCard } from './diagram'
import { MERMAID_CONFIG, readTheme } from './diagram-theme'
import { endsInOpenFence } from './policy'

vi.mock('../../../ui', () => ({ IconButton: ({ label }: { label: string }) => `<button aria-label="${label}"></button>` }))
vi.mock('../copy', () => ({ copyText: () => undefined }))

const render = (text: string, live = false) => renderToStaticMarkup(createElement(Markdown, { text, live }))
const FLOW = 'flowchart LR\n  A[Start] --> B[End]'
const fence = (lang: string, body = FLOW, mark = '```') => `${mark}${lang}\n${body}\n${mark}`
const diagrams = (html: string) => [...html.matchAll(/data-md-diagram/g)].length
const codeBlocks = (html: string) => [...html.matchAll(/data-md-code/g)].length

describe('endsInOpenFence', () => {
  it.each([
    ['```mermaid\nflowchart LR', true],
    ['```mermaid\nflowchart LR\n```', false],
    ['```mermaid\nflowchart LR\n```\n\nand then', false],
    ['~~~mermaid\nflowchart LR', true],
    ['~~~mermaid\nflowchart LR\n~~~', false],
    // A closing fence is as long as the opening one, and of the same mark.
    ['````mermaid\nx\n```', true],
    ['````mermaid\nx\n````', false],
    ['```mermaid\nx\n~~~', true],
    // A closing fence holds no text after it.
    ['```mermaid\nx\n``` y', true],
    ['> ```mermaid\n> flowchart LR', true],
    ['no fence at all', false],
    ['', false],
    // Two blocks: the second is the open one.
    [`${fence('sql', 'select 1')}\n\n\`\`\`mermaid\nflow`, true],
  ])('%j -> %s', (text, open) => expect(endsInOpenFence(text)).toBe(open))
})

describe('a mermaid fence is a diagram', () => {
  it.each([['```', 'mermaid'], ['~~~', 'mermaid'], ['```', 'mermaid title="x"']])('%s%s', (mark, lang) => {
    const html = render(`before\n\n${fence(lang, FLOW, mark)}\n\nafter`)
    expect(diagrams(html)).toBe(1)
    expect(codeBlocks(html)).toBe(0)
    // Until Mermaid has drawn it (it loads on first use, in the browser), a quiet line, not the source.
    expect(html).toContain('Drawing diagram')
    expect(html).not.toContain('flowchart LR')
  })

  it('other fences stay code blocks, whatever their name looks like', () => {
    for (const lang of ['', 'sql', 'mermaidx', 'xmermaid', 'mermaid-js']) {
      const html = render(fence(lang, 'select 1'))
      expect(diagrams(html), lang).toBe(0)
      expect(codeBlocks(html), lang).toBe(1)
    }
  })

  it('a diagram is numbered apart from the code blocks around it', () => {
    const html = render([fence('sql', 'select 1'), fence('mermaid'), fence('sql', 'select 2')].join('\n\n'))
    expect(html).toContain('Code block 1, sql')
    expect(html).toContain('Code block 2, sql')
    expect(html).not.toContain('Code block 3')
  })

  it('every diagram of a text is one (each gets its own)', () => {
    expect(diagrams(render([fence('mermaid'), fence('mermaid')].join('\n\n')))).toBe(2)
  })

  it('a diagram in a quote or list is still one', () => {
    expect(diagrams(render(`> ${'```mermaid'}\n> ${FLOW.split('\n').join('\n> ')}\n> \`\`\``))).toBe(1)
  })

  it('while the fence is open and the text is live, it is the quiet line, and no source or error shows', () => {
    const html = render('Here:\n\n```mermaid\nflowchart LR\n  A[Sta', true)
    expect(html).toContain('Drawing diagram')
    expect(html).not.toMatch(/Couldn.t draw|A\[Sta/)
  })
})

describe('the card for each state', () => {
  const card = (view: Parameters<typeof DiagramCard>[0]['view']) => renderToStaticMarkup(createElement(DiagramCard, { n: 2, source: FLOW, view }))

  it('drawing: the quiet line, marked busy', () => {
    const html = card({ kind: 'drawing' })
    expect(html).toContain('data-state="drawing"')
    expect(html).toContain('aria-busy="true"')
  })

  it('failed: a note, and the source as a plain code block', () => {
    const html = card({ kind: 'failed' })
    expect(html).toContain('data-state="failed"')
    expect(html).toContain('Couldn&#x27;t draw this diagram.')
    expect(html).toContain('data-md-code')
    expect(html).toContain('flowchart LR')
    expect(html).toContain('Diagram 2 source')
  })

  it('ready: the figure inside a named, keyboard-scrollable region in a bordered card, with Show source and Copy', () => {
    const html = card({ kind: 'ready', svg: '<svg role="img" aria-label="Diagram 2"></svg>' })
    expect(html).toContain('data-state="ready"')
    expect(html).toContain('<svg role="img" aria-label="Diagram 2"></svg>')
    expect(html).toMatch(/role="region" aria-label="Diagram 2" tabindex="0"[^>]*overflow-x-auto/)
    expect(html).toContain('border border-border')
    expect(html).toContain('Show diagram 2 source')
    expect(html).toContain('Copy diagram 2 source')
    // The source stays folded until asked for.
    expect(html).not.toContain('flowchart LR')
  })
})

describe('Mermaid is set up for untrusted text', () => {
  it('uses the strict level, no HTML labels, no scanning of the page, and no error figure of its own', () => {
    expect(MERMAID_CONFIG).toMatchObject({ securityLevel: 'strict', htmlLabels: false, startOnLoad: false, suppressErrorRendering: true })
  })
})

describe('the theme comes from the tokens', () => {
  // The values are stand-ins: the conversion to a colour Mermaid can read is the browser's (simpleColor), left out here.
  const tokens: Record<string, string> = {
    '--card': 'card-value', '--foreground': 'ink-value', '--foreground-3': 'line-value', '--fill': 'fill-value', '--fill-hover': 'hover-value',
    '--muted': 'muted-value', '--border-strong': 'edge-value', '--brand-tint': 'tint-value', '--font-sans': ' Geist, sans-serif ',
  }
  const read = (name: string) => tokens[name] ?? ''

  it('maps role tokens to Mermaid variables, with the font and the mode', () => {
    const t = readTheme(read, true, c => c)
    expect(t.dark).toBe(true)
    expect(t.fontFamily).toBe('Geist, sans-serif')
    expect(t.themeVariables).toMatchObject({
      darkMode: true, background: 'card-value', textColor: 'ink-value', lineColor: 'line-value', primaryColor: 'fill-value',
      nodeBorder: 'edge-value', secondaryColor: 'hover-value', clusterBkg: 'muted-value',
    })
  })

  it('fails loud on a token the page does not set', () => {
    expect(() => readTheme(name => (name === '--fill' ? '' : read(name)), false, c => c)).toThrow('--fill is not set')
  })
})
