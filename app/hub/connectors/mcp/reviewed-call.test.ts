// M4-C2 (#692 round 1): Slack's era is pinned as legacy, so its wire is the old client's and a bad `server/discover`
// answer can't reach its credentials; the notes fixture stays unpinned, so the probe path stays covered.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { codeOf, connect, NOTES, SLACK, world } from '../../oauth/testing/kit'

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => vi.restoreAllMocks())

const slackRead = (w: ReturnType<typeof world>) => w.core(SLACK).mcpCall({ accountId: SLACK, upstream: 'slack_search_public', args: { keywords: ['late'] } })
const notesRead = (w: ReturnType<typeof world>) => w.core(NOTES).mcpCall({ accountId: NOTES, upstream: 'notes_search', args: { query: 'late' } })

describe("Slack's pinned era", () => {
  it("Slack's first read sends no server/discover: initialize, the notification, then the call", async () => {
    const w = world()
    await connect(w)
    const before = w.slack.requests.length
    expect(codeOf(await slackRead(w))).toBe('ok')
    expect(w.slack.requests.slice(before).map(r => r.rpc)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
  })

  it('a server/discover answered 401 never reaches Slack: the read succeeds and the token stays', async () => {
    const w = world()
    await connect(w)
    const real = w.slack.fetch
    let probes = 0
    w.slack.fetch = async req => {
      const body = req.method === 'POST' ? ((await req.clone().json().catch(() => null)) as { method?: unknown } | null) : null
      if (body?.method === 'server/discover') return probes++, new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } })
      return real(req)
    }
    expect(codeOf(await slackRead(w))).toBe('ok')
    expect(codeOf(await slackRead(w))).toBe('ok')
    expect(probes).toBe(0)
    const r = w.store(SLACK).record()!
    expect(r.state).toBe('active')
    expect(r.token).not.toBeNull()
  })

  it('the re-send after one 401 is pinned too: no server/discover, and the token stays (#701)', async () => {
    const w = world()
    await connect(w)
    const real = w.slack.fetch
    const seen: string[] = []
    let inits = 0
    w.slack.fetch = async req => {
      const body = req.method === 'POST' ? ((await req.clone().json().catch(() => null)) as { method?: string } | null) : null
      if (body?.method) seen.push(body.method)
      const refuse = body?.method === 'server/discover' || (body?.method === 'initialize' && inits++ === 0)
      return refuse ? new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }) : real(req)
    }
    expect(codeOf(await slackRead(w))).toBe('ok')
    expect(seen).toEqual(['initialize', 'initialize', 'notifications/initialized', 'tools/call'])
    expect(w.store(SLACK).record()!.state).toBe('active')
  })

  it('control: the notes fixture is unpinned, so its first read probes with server/discover and falls back', async () => {
    const w = world()
    await connect(w, NOTES)
    const before = w.notes.requests.length
    expect(codeOf(await notesRead(w))).toBe('ok')
    expect(w.notes.requests.slice(before).map(r => r.rpc)).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/call'])
  })

  it("the notes fixture's era is cached: after the server drops its session, the new session needs no second probe", async () => {
    const w = world()
    await connect(w, NOTES)
    expect(codeOf(await notesRead(w))).toBe('ok')
    w.notes.sessions.clear()
    const before = w.notes.requests.length
    expect(codeOf(await notesRead(w))).toBe('ok')
    expect(w.notes.requests.slice(before).map(r => r.rpc)).toEqual(['tools/call', 'initialize', 'notifications/initialized', 'tools/call'])
  })
})
