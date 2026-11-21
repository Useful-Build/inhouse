// Whether a link to a tool names one. Ways it can fail: the sign-in's return (`/tools/slack` before the tools are read) judged
// on the empty list, so it bounces to Tools with "That page doesn't exist" and two toasts stack; a stale key never judged
// unknown once the read has answered; a tool with a history here (disconnected, a refused first connect) not known.
import { describe, expect, test } from 'vitest'
import { toolRoute } from './tool-route'
import type { ToolsData } from '../agent/types'

const at = { iso: '2026-11-20T10:00:00.000Z', ms: Date.parse('2026-11-20T10:00:00.000Z') }
const detail = { name: 'Slack', desc: 'd', ex: [], read: 'r', draft: 'd', run: 'r', conn: 'c', site: 'slack.com' }
const tools = (over: Partial<ToolsData> = {}): ToolsData => ({ connected: [], channels: [], beingConnected: [], lastRead: { default: at }, catalog: [], details: {}, connection: {}, setup: {}, readDone: 0, ...over })

describe('toolRoute', () => {
  test('before the tools are read, an unlisted key waits (the sign-in return), it is not unknown', () => {
    expect(toolRoute(tools(), 'slack', 'loading')).toBe('wait')
  })
  test('once the read has answered, an unlisted key is unknown, whether the read worked or failed', () => {
    expect(toolRoute(tools(), 'slack', 'ready')).toBe('unknown')
    expect(toolRoute(tools(), 'slack', 'error')).toBe('unknown')
  })
  test('a tool or channel in the data is known, whatever the status', () => {
    expect(toolRoute(tools({ details: { slack: detail } }), 'slack', 'ready')).toBe('known')
    expect(toolRoute(tools({ details: { slack: detail } }), 'slack', 'loading')).toBe('known')
    expect(toolRoute(tools({ channels: [{ key: 'slack', name: 'Slack', desc: 'd', need: 1, since: at, site: 'slack.com' }] }), 'slack', 'ready')).toBe('known')
  })
  test('a key that only looks like an Object property is unknown', () => {
    expect(toolRoute(tools(), 'toString', 'ready')).toBe('unknown')
  })
})
