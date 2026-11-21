// What the P3 chat specs share (W7 PR 2): making a chat and sending a turn through the API alone, waiting for an answer
// without a fixed sleep, and a socket client ("a tab") that records the frames it is sent. Specs that run a turn need a
// container, which only the per-PR test deployment has (E2E_TEST_BUILD_REMOTE); `needsContainer()` skips them anywhere else.
// A turn plays the scripted model's scenario named in its text (`scenario:hello ...`, app/test/scripted-model/scenarios.ts).
import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import { appOrigin, call, mint } from './kit.ts'
import type { Actor, Reply } from './kit.ts'

/** Skips the test unless a container can run (the per-PR deployment). Call it first in the test body. */
export function needsContainer(): void {
  test.skip(!process.env.E2E_TEST_BUILD_REMOTE, 'runs a turn, which needs a container: it runs on the per-PR test deployment (E2E_TEST_BUILD_REMOTE)')
}

export const newChatId = (): string => `e2e-${randomUUID().replaceAll('-', '').slice(0, 20)}`

export async function createChat(request: APIRequestContext, who: Actor, id: string = newChatId(), title = 'E2E chat'): Promise<string> {
  const r = await call(request, who, 'POST', '/api/chats', { json: { id, title } })
  expect(r.status, r.text).toBe(200)
  return id
}

export interface Sent { runId: string; turnId: string; messageId: string; position: 'starting' | 'queued' }

/** Route 29 with the `sonnet` picker id and a fresh client key; the reply is returned as it came (a spec may expect a refusal). */
export const sendTurn = (request: APIRequestContext, who: Actor, chatId: string, text: string, extra: Record<string, unknown> = {}): Promise<Reply> =>
  call(request, who, 'POST', `/api/chats/${chatId}/turns`, { json: { clientTurnKey: `k-${randomUUID().replaceAll('-', '').slice(0, 20)}`, text, model: 'sonnet', ...extra } })

export async function send(request: APIRequestContext, who: Actor, chatId: string, text: string): Promise<Sent> {
  const r = await sendTurn(request, who, chatId, text)
  expect([200, 201, 202], r.text).toContain(r.status)
  return r.json as Sent
}

interface StoredMsg { role: string; turnId: string; pos: number; part?: { type: string; text?: string } }

/** The agent messages of a turn once they are stored (a turn's messages are written in one batch when it ends), by polling route 24. */
export async function answerOf(request: APIRequestContext, who: Actor, chatId: string, turnId: string, timeoutMs = 120_000): Promise<StoredMsg[]> {
  let found: StoredMsg[] = []
  await expect.poll(async () => {
    const r = await call(request, who, 'GET', `/api/chats/${chatId}`)
    expect(r.status, r.text).toBe(200)
    found = (r.json.messages as StoredMsg[]).filter(m => m.role === 'agent' && m.turnId === turnId).sort((a, b) => a.pos - b.pos)
    return found.length
  }, { timeout: timeoutMs, message: `the answer of turn ${turnId}` }).toBeGreaterThan(0)
  return found
}

export const textOf = (messages: StoredMsg[]): string => messages.filter(m => m.part?.type === 'text').map(m => m.part!.text ?? '').join('\n')

/** A frame the socket sent, as the contract's envelope. */
export interface Frame { v: number; chatId: string; runId: string; seq: number; at: unknown; event: { type: string; [k: string]: unknown } }
type ServerMsg = { type: 'frame'; frame: Frame } | { type: 'attached'; runId: string; lastSeq: number; live: boolean } | { type: 'refused'; runId: string; code: string }

/** Node's WebSocket (undici) takes a second argument with request headers, which a browser's doesn't. */
type NodeWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket
const SocketCtor = WebSocket as unknown as NodeWebSocket

/**
 * One tab: a socket opened as `who` with the app's own `Origin` and a fresh test-issuer token. It records every message in
 * order. Waits are by condition with a timeout, never a fixed sleep.
 */
export class Tab {
  readonly messages: ServerMsg[] = []
  closed: { code: number; reason: string } | null = null
  private ws!: WebSocket
  private listeners = new Set<() => void>()

  static async open(who: Actor, o: { origin?: string; v?: number } = {}): Promise<Tab> {
    const tab = new Tab()
    const base = appOrigin(who.app)
    const token = await mint(who)
    await new Promise<void>((resolve, reject) => {
      const ws = new SocketCtor(`${base.replace(/^http/, 'ws')}/api/socket?v=${o.v ?? 1}`, { headers: { 'Cf-Access-Jwt-Assertion': token, Origin: o.origin ?? base } })
      tab.ws = ws
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('the socket did not open')), { once: true })
      ws.addEventListener('message', e => { tab.messages.push(JSON.parse(String(e.data)) as ServerMsg); tab.wake() })
      ws.addEventListener('close', e => { tab.closed = { code: e.code, reason: e.reason }; tab.wake() })
    })
    return tab
  }

  private wake(): void { for (const l of [...this.listeners]) l() }

  /** Resolves once `ok()` holds (checked on every message and close), or fails after `ms`. */
  async until(ok: () => boolean, what: string, ms = 60_000): Promise<void> {
    if (ok()) return
    const signal = AbortSignal.timeout(ms)
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { this.listeners.delete(check); reject(new Error(`timed out waiting for ${what}`)) }
      const check = () => { if (ok()) { signal.removeEventListener('abort', onAbort); this.listeners.delete(check); resolve() } }
      signal.addEventListener('abort', onAbort, { once: true })
      this.listeners.add(check)
    })
  }

  attach(runId: string, fromSeq = 0): void { this.ws.send(JSON.stringify({ type: 'attach', runId, fromSeq })) }
  close(): void { this.ws.close() }

  frames(runId?: string): Frame[] { return this.messages.flatMap(m => (m.type === 'frame' && (runId === undefined || m.frame.runId === runId) ? [m.frame] : [])) }
  seqs(runId: string): number[] { return this.frames(runId).map(f => f.seq) }
  types(runId: string): string[] { return this.frames(runId).map(f => f.event.type) }
  /** True once the turn's `turn.finished` frame arrived (the run may stay live after its last turn). */
  turnFinished(turnId: string): boolean { return this.frames().some(f => f.event.type === 'turn.finished' && f.event.turnId === turnId) }
}

/** The seqs are 1, 2, 3, ... with no gap and no repeat, in the order they arrived. */
export const contiguousFrom = (seqs: number[], first = 1): number[] => seqs.map((_, i) => first + i)
