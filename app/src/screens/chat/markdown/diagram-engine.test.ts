// The weight guard at run time: importing the engine (or a whole renderer) loads no Mermaid; the first diagram loads it
// once; a failed draw throws what Mermaid threw (the card shows the source and logs it).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagramTheme } from './diagram-theme'

const mermaid = vi.hoisted(() => ({ loaded: 0, initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => { mermaid.loaded++; return { default: { initialize: mermaid.initialize, render: mermaid.render } } })
vi.mock('../../../ui', () => ({ IconButton: () => null }))
vi.mock('../copy', () => ({ copyText: () => undefined }))
vi.mock('./diagram-svg', () => ({ tidySvg: (svg: string, label: string) => `${label}|${svg}` }))

const theme: DiagramTheme = { dark: false, fontFamily: 'Geist', themeVariables: { primaryColor: 'fill-value' } }

describe('the diagram engine', () => {
  beforeEach(() => { mermaid.initialize.mockReset(); mermaid.render.mockReset() })

  it('loads Mermaid on the first draw, not on import, and only once', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    // Rendering a whole text with no diagram does not load it either.
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { createElement } = await import('react')
    renderToStaticMarkup(createElement((await import('./renderer')).Markdown, { text: '# Hi\n\n```sql\nselect 1\n```' }))
    expect(mermaid.loaded).toBe(0)
    mermaid.render.mockResolvedValue({ svg: '<svg/>' })
    await drawDiagram('flowchart LR\n A-->B', 'ih-diagram-x', 'Diagram 1', theme)
    await drawDiagram('flowchart LR\n A-->B', 'ih-diagram-y', 'Diagram 2', theme)
    expect(mermaid.loaded).toBe(1)
  })

  it('draws with the strict config and the theme of the moment, and returns the tidied figure', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    mermaid.render.mockResolvedValue({ svg: '<svg/>' })
    const out = await drawDiagram('flowchart LR\n A-->B', 'ih-diagram-x', 'Diagram 1', theme)
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({
      securityLevel: 'strict', htmlLabels: false, theme: 'base', fontFamily: 'Geist', themeVariables: { primaryColor: 'fill-value' },
    }))
    expect(mermaid.render).toHaveBeenCalledWith('ih-diagram-x', 'flowchart LR\n A-->B')
    expect(out).toBe('Diagram 1|<svg/>')
  })

  it('throws what Mermaid throws for a diagram it cannot parse', async () => {
    const { drawDiagram } = await import('./diagram-engine')
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2'))
    await expect(drawDiagram('not a diagram', 'ih-diagram-x', 'Diagram 1', theme)).rejects.toThrow('Parse error on line 2')
  })
})
