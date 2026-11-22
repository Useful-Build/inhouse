import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { agent } from '../agent'
import type { ToolDetail } from '../agent/types'
import { Chats } from './Chats'

// Render the browser's current snapshots in Node, without starting a server or running effects.
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useSyncExternalStore: <T>(subscribe: (listener: () => void) => () => void, read: () => T, serverRead?: () => T) =>
      react.useSyncExternalStore(subscribe, read, serverRead ?? read),
  }
})
vi.mock('@client', async () => {
  const { HttpAgent } = await import('../agent/http/client')
  const client = new HttpAgent()
  client.subscribe = () => () => undefined // Keep the UI store's eager subscription from starting HTTP reads.
  return { default: { agent: client, demo: null, now: () => 0 } }
})
vi.hoisted(() => {
  const media = { matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }
  vi.stubGlobal('window', { addEventListener: () => undefined, matchMedia: () => media })
  vi.stubGlobal('localStorage', { getItem: () => null })
})

afterEach(() => { vi.restoreAllMocks() })

const since = { iso: '2026-06-01T10:00:00.000Z', ms: Date.parse('2026-06-01T10:00:00Z') }
const tool = (name: string): ToolDetail => ({ name, desc: '', ex: [], read: '', draft: '', run: '', conn: '', site: '', since })
const NONE = 'No tools are connected yet.'
const UNREADABLE = "Your Inhouse agent can&#x27;t read any of your tools right now."

function blankChat(states: ('readable' | 'paused' | 'disconnected')[]) {
  const data = agent.read()
  const state = agent.getSnapshot()
  const keys = ['shopify', 'amazon'].slice(0, states.length)
  vi.spyOn(agent, 'read').mockReturnValue({
    ...data, status: 'ready',
    tools: {
      ...data.tools, connected: keys,
      details: Object.fromEntries(keys.map((key, i) => [key, tool(i === 0 ? 'Store' : 'Marketplace')])),
      connection: Object.fromEntries(keys.filter((_, i) => states[i] === 'disconnected').map(key => [key, { status: 'disconnected', since }] as const)),
    },
  })
  vi.spyOn(agent, 'getSnapshot').mockReturnValue({
    ...state, toolPaused: Object.fromEntries(keys.filter((_, i) => states[i] === 'paused').map(key => [key, true] as const)),
  })
  return renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Chats)))
}

describe('empty chat tool status', () => {
  test.each(['paused', 'disconnected'] as const)('does not prompt to connect an existing %s tool', status => {
    const html = blankChat([status])
    expect(html).toContain(UNREADABLE)
    expect(html).not.toContain(NONE)
    expect(html).not.toContain('>Connect tools</button>')
    expect(html).toContain('>Manage tools</button>')
  })

  test('offers to connect tools when none have been connected', () => {
    const html = blankChat([])
    expect(html).toContain(NONE)
    expect(html).toContain('>Connect tools</button>')
    expect(html).not.toContain(UNREADABLE)
  })

  test('names readable tools, not a paused one', () => {
    const html = blankChat(['readable', 'paused'])
    expect(html).toContain('Your Inhouse agent reads Store.')
    expect(html).not.toContain('Your Inhouse agent reads Store and Marketplace.')
    expect(html).not.toContain(UNREADABLE)
  })
})
