// The client error reporter's log line (worker/client-error.ts, P8a P-auth). A report is free text from a browser: its
// message and stack can quote what was on screen (a customer's name, an order note, a file name, a chat line), which the
// scrubber's patterns don't catch. Ways it could fail, written down first:
//  1. the report's message reaches Workers Logs;
//  2. a stack's header line (`TypeError: <message>`) or any other non-frame line reaches it;
//  3. a frame keeps its URL's query string;
//  4. what an operator needs is lost: the kind, the release, the page path, the error's name, the code locations.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportClientError } from './routes.ts'

const CANARY = 'CANARY-customer-name-7f3a'
let ip = 0

async function logged(report: Record<string, unknown>): Promise<Record<string, unknown>> {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const res = await reportClientError(new Request('https://brand.example/api/client-error', {
    method: 'POST', body: JSON.stringify(report), headers: { 'CF-Connecting-IP': `198.51.100.${++ip}` },
  }))
  expect(res.status).toBe(204)
  const lines = error.mock.calls.map(([line]) => line as Record<string, unknown>).filter(l => l.event === 'client_error')
  expect(lines).toHaveLength(1)
  return lines[0]!
}

afterEach(() => vi.restoreAllMocks())

describe('client_error log line', () => {
  it('carries no message or stack text, only the name and the code locations (failures 1, 2, 4)', async () => {
    const line = await logged({
      message: `Unexpected token in JSON at position 3: "${CANARY}"`,
      stack: [
        `SyntaxError: Unexpected token in JSON at position 3: "${CANARY}"`,
        `    and the order note said ${CANARY}`,
        '    at JSON.parse (<anonymous>)',
        '    at parseNote (https://brand.example/assets/index-abc123.js:1:2345)',
        '    at https://brand.example/assets/index-abc123.js:2:10',
        `    at ${CANARY} said hello (https://brand.example/assets/index-abc123.js:3:4)`,
        'parseNote@https://brand.example/assets/index-abc123.js:1:2345',
      ].join('\n'),
      url: 'https://brand.example/chats/c1?q=secret#frag',
      release: 'abc123',
      kind: 'error',
    })
    expect(JSON.stringify(line)).not.toContain(CANARY)
    expect(line).toMatchObject({ event: 'client_error', kind: 'error', release: 'abc123', url: 'https://brand.example/chats/c1', name: 'SyntaxError' })
    expect(line.frames).toEqual([
      'at parseNote (https://brand.example/assets/index-abc123.js:1:2345)',
      'at https://brand.example/assets/index-abc123.js:2:10',
      'parseNote@https://brand.example/assets/index-abc123.js:1:2345',
    ])
    expect(line).not.toHaveProperty('message')
    expect(line).not.toHaveProperty('stack')
  })
  it("a frame's URL loses its query string (failure 3)", async () => {
    const line = await logged({ stack: 'Error: x\n    at f (https://brand.example/a.js?token=abc:1:2)', kind: 'rejection' })
    expect(line.frames).toEqual(['at f (https://brand.example/a.js:1:2)'])
    expect(line.name).toBe('Error')
  })
  it("keeps only frames on the page's own http(s) origin: a message line shaped like a frame doesn't survive", async () => {
    const line = await logged({
      stack: [
        'Error: x',
        '    at x (note:Jane_Smith:1:2)',
        '    at y (https://other.example/evil.js:1:2)',
        'z@note:Jane_Smith:3:4',
        '    at ok (https://brand.example/assets/a.js:5:6)',
      ].join('\n'),
      kind: 'error',
    })
    expect(JSON.stringify(line)).not.toContain('Jane_Smith')
    expect(line.frames).toEqual(['at ok (https://brand.example/assets/a.js:5:6)'])
  })
  it('a report with no stack logs no name and no frames', async () => {
    const line = await logged({ message: CANARY, kind: 'boundary' })
    expect(JSON.stringify(line)).not.toContain(CANARY)
    expect(line).toMatchObject({ kind: 'boundary', name: 'unknown', frames: [] })
  })
})
