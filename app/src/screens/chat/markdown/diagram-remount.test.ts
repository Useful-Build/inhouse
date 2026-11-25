// @vitest-environment jsdom
// A finished answer keeps its diagram. Ways it could break, written first: the answer's tree is swapped when it stops
// being live (Streamdown's `static` mode is a different tree) or when its link hosts fill in (a new component set), so the
// diagram remounts, shows "Drawing diagram…" and draws again; a theme change takes the figure on screen away while the
// redraw runs (`mermaid.render(id)` removes the element with that id); a figure drawn once is drawn again on a remount.
import { createElement } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagramTheme } from './diagram-theme'

const engine = vi.hoisted(() => ({ draws: [] as { source: string; id: string; dark: boolean }[] }))
vi.mock('./diagram-engine', () => ({
  drawDiagram: async (source: string, id: string, label: string, theme: DiagramTheme) => {
    engine.draws.push({ source, id, dark: theme.dark })
    return `<svg role="img" aria-label="${label}" data-dark="${theme.dark}"></svg>`
  },
}))
vi.mock('./diagram-theme', async orig => ({
  ...(await orig<typeof import('./diagram-theme')>()),
  readTheme: (_read: unknown, dark: boolean): DiagramTheme => ({ dark, fontFamily: 'Geist', themeVariables: { darkMode: dark } }),
}))
vi.mock('../../../ui', () => ({ IconButton: ({ label, onClick }: { label: string; onClick?: () => void }) => createElement('button', { 'aria-label': label, onClick }) }))
vi.mock('../copy', () => ({ copyText: () => undefined }))

const { Markdown } = await import('./renderer')

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { engine.draws = []; host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); document.documentElement.classList.remove('dark') })

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const show = async (props: Parameters<typeof Markdown>[0]) => { await act(async () => root.render(createElement(Markdown, props))); await flush() }
const card = () => host.querySelector('[data-md-diagram]')

describe('a diagram in an answer', () => {
  it('is drawn once, and stays the same element when the answer finishes and its link hosts fill in', async () => {
    const text = 'Here is how it goes.\n\n```mermaid\nflowchart LR\n  A[Asked] --> B[Refunded]\n```\n\nThen [the policy](https://help.example.com/refunds).'
    await show({ text, live: true })
    const first = card()
    expect(first?.getAttribute('data-state')).toBe('ready')
    expect(engine.draws).toHaveLength(1)
    await show({ text, live: false, linkHosts: ['help.example.com'] })
    expect(card()).toBe(first)
    expect(card()?.getAttribute('data-state')).toBe('ready')
    expect(engine.draws).toHaveLength(1)
    // The hosts did reach the link.
    expect(host.querySelector('a[href="https://help.example.com/refunds"]')).not.toBeNull()
  })

  it('keeps Show source open when the answer finishes', async () => {
    const text = '```mermaid\nflowchart LR\n  S[Show] --> T[Source]\n```\n\nmore'
    await show({ text, live: true })
    await act(async () => (host.querySelector('button[aria-label="Show diagram 1 source"]') as HTMLButtonElement).click())
    expect(host.querySelector('button[aria-label="Hide diagram 1 source"]')).not.toBeNull()
    await show({ text, live: false, linkHosts: ['x.example.com'] })
    expect(host.querySelector('button[aria-label="Hide diagram 1 source"]')).not.toBeNull()
  })

  it('draws with a new id each time (a theme redraw never reuses the id of the figure on screen), and reuses a figure drawn before', async () => {
    const text = '```mermaid\nflowchart LR\n  L[Light] --> D[Dark]\n```'
    await show({ text })
    await act(async () => document.documentElement.classList.add('dark'))
    await flush()
    expect(engine.draws.map(d => d.dark)).toEqual([false, true])
    expect(new Set(engine.draws.map(d => d.id)).size).toBe(2)
    expect(host.querySelector('svg')?.getAttribute('data-dark')).toBe('true')
    // Back to light: that figure is already drawn, so no draw, and a remount (a chat opened again) shows it at once.
    await act(async () => document.documentElement.classList.remove('dark'))
    await flush()
    expect(engine.draws).toHaveLength(2)
    await act(async () => root.render(createElement('div')))
    await act(async () => root.render(createElement(Markdown, { text })))
    expect(card()?.getAttribute('data-state')).toBe('ready')
    expect(engine.draws).toHaveLength(2)
  })
})
