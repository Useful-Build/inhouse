// The chat socket (p3-design 3, route 34, and 4.10): one per tab, opened with the first run followed and closed with the
// last. Each followed run has a `RunFeed`, so the events leave in order and once whatever the connection does. Plain
// code: the schemas come in through `parts` (loaded with the chunk), the WebSocket through `open`, the timers through
// `after`, so a test drives all three.
//  - after a drop and on every `attached` that says the server holds more than the feed has, the run is attached again
//    from the feed's last contiguous seq (`RunFeed.reattachFrom()`), never from the last frame seen;
//  - a re-attach from the seq the last attach started at, which brought nothing, isn't asked again (no loop);
//  - close codes follow `closeOutcome`: 4401 asks `onReauth` (true: reconnect with the sign-in it holds), 4403 drops
//    every run and tells `onGrantEnded`, 4409 asks for a reload, 1012 and any other drop reconnect with a growing wait.
import type { AgentErrorCode, LinkState, RunFrame } from '../../types'
import { closeOutcome } from './close'
import { RunFeed } from './feed'
import type { FeedParts } from './feed'

/** The part of a browser WebSocket this uses. */
export interface SocketLike {
  send(data: string): void
  close(code?: number): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number }) => void) | null
}

/** What the socket needs from the schemas chunk. */
export interface SocketParts extends FeedParts {
  /** An `attached` or `refused` message, or null for one it can't read (a frame is read by the feed). */
  parseControl(raw: unknown): { type: 'attached'; runId: string; lastSeq: number } | { type: 'refused'; runId: string; code: AgentErrorCode } | null
}

export interface ChatSocketOptions {
  open: () => SocketLike
  parts: () => Promise<SocketParts>
  /** 4401: the session or the lease ended. Resolves true when the person is still signed in (reconnect), false when not. */
  onReauth: () => Promise<boolean>
  /** 4403: a support grant ended; the chat's privileged data is to be dropped. */
  onGrantEnded: () => void
  after?: (fn: () => void, ms: number) => unknown
  cancel?: (timer: unknown) => void
}

interface Sub {
  feed: RunFeed
  onFrame: (f: RunFrame) => void
  onRefused?: (code: AgentErrorCode) => void
  /** The `fromSeq` of the last attach sent, so a re-attach that would repeat it is refused. */
  askedFrom: number | null
}

const WAIT_MIN_MS = 500
const WAIT_MAX_MS = 10_000

export class ChatSocket {
  private subs = new Map<string, Sub>()
  private ws: SocketLike | null = null
  private opened = false
  private state: LinkState = 'live'
  private listeners = new Set<(s: LinkState) => void>()
  private timer: unknown = null
  private wait = WAIT_MIN_MS
  private parts: SocketParts | null = null
  private connecting = false
  /** Bumped by every close of ours: a socket whose number isn't the current one is a stale one. */
  private epoch = 0
  private readonly o: ChatSocketOptions
  constructor(o: ChatSocketOptions) { this.o = o }

  link = (): LinkState => this.state
  onLink = (l: (s: LinkState) => void): (() => void) => { this.listeners.add(l); return () => { this.listeners.delete(l) } }
  private setLink(s: LinkState) {
    if (this.state === s) return
    this.state = s
    this.listeners.forEach(l => l(s))
  }

  /** Follows a run from after `fromSeq`. A second attach of the same run replaces the first. Returns the detach. */
  attach(runId: string, onFrame: (f: RunFrame) => void, fromSeq = 0, onRefused?: (code: AgentErrorCode) => void): () => void {
    // The page can't read this server: nothing is followed until a reload.
    if (this.state === 'reload' || this.state === 'grantEnded') return () => undefined
    const first = !this.parts
    const sub: Sub = { feed: new RunFeed(runId, { accepts: v => this.parts?.accepts(v) ?? false, parseEvent: r => this.parts?.parseEvent(r) ?? null, logSkip: s => this.parts?.logSkip?.(s) }, fromSeq), onFrame, askedFrom: null }
    if (onRefused) sub.onRefused = onRefused
    this.subs.set(runId, sub)
    // A socket that is open follows the new run at once; one that isn't attaches every run when it opens.
    if (this.ws && this.opened) this.attachFrom(runId, sub, sub.feed.contiguous)
    void this.ensure(first)
    return () => this.detach(runId, sub)
  }

  private detach(runId: string, sub: Sub) {
    if (this.subs.get(runId) !== sub) return
    this.subs.delete(runId)
    if (this.ws && this.opened) this.sendMsg({ type: 'detach', runId })
    if (this.subs.size === 0) this.shut()
  }

  /** Sign out: the socket closes first, and nothing reconnects. */
  close(): void {
    this.subs.clear()
    this.shut()
  }

  private shut() {
    this.epoch++
    if (this.timer !== null) { (this.o.cancel ?? clearTimeout)(this.timer as never); this.timer = null }
    const ws = this.ws
    this.ws = null; this.opened = false; this.connecting = false; this.wait = WAIT_MIN_MS
    if (ws) { ws.onopen = ws.onmessage = ws.onclose = null; try { ws.close(1000) } catch { /* already closed */ } }
    if (this.state === 'held') this.setLink('live')
  }

  private async ensure(_first: boolean) {
    if (this.ws || this.connecting || this.timer !== null) return
    this.connecting = true
    const epoch = this.epoch
    try { this.parts ??= await this.o.parts() } catch (e) {
      this.connecting = false
      console.error('Inhouse: the schemas chunk did not load, so no answer can be followed.', e)
      return
    }
    this.connecting = false
    // Closed (or every run detached) while the chunk loaded.
    if (epoch !== this.epoch || this.subs.size === 0 || this.ws) return
    this.connect()
  }

  private connect() {
    const epoch = this.epoch
    let ws: SocketLike
    try { ws = this.o.open() } catch (e) { console.warn('Inhouse: could not open the chat socket.', e); this.drop(); return }
    this.ws = ws
    this.opened = false
    ws.onopen = () => {
      if (epoch !== this.epoch) return
      this.opened = true
      this.wait = WAIT_MIN_MS
      this.setLink('live')
      // Every run still followed is attached again from where its feed is contiguous.
      for (const [runId, sub] of this.subs) this.attachFrom(runId, sub, sub.feed.reattachFrom())
    }
    ws.onmessage = e => { if (epoch === this.epoch) this.message(e.data) }
    ws.onclose = e => { if (epoch === this.epoch) this.closed(e.code) }
  }

  private sendMsg(m: { type: 'attach'; runId: string; fromSeq: number } | { type: 'detach'; runId: string }) {
    try { this.ws?.send(JSON.stringify(m)) } catch (e) { console.warn('Inhouse: could not send on the chat socket.', e) }
  }
  private attachFrom(runId: string, sub: Sub, fromSeq: number) {
    sub.askedFrom = fromSeq
    this.sendMsg({ type: 'attach', runId, fromSeq })
  }

  private message(data: unknown) {
    let raw: unknown
    try { raw = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer)) } catch { return }
    if (typeof raw !== 'object' || raw === null) return
    const m = raw as Record<string, unknown>
    if (m.type === 'frame') return this.frame(m.frame)
    const c = this.parts?.parseControl(raw)
    if (!c) return
    const sub = this.subs.get(c.runId)
    if (!sub) return
    if (c.type === 'refused') {
      this.subs.delete(c.runId)
      sub.onRefused?.(c.code)
      if (this.subs.size === 0) this.shut()
      return
    }
    // The server holds more than the feed has (a long replay comes 500 frames at a time, or frames were lost): again from the last contiguous seq.
    if (sub.feed.contiguous < c.lastSeq) {
      const from = sub.feed.reattachFrom()
      if (from !== sub.askedFrom) this.attachFrom(c.runId, sub, from)
    }
  }

  private frame(raw: unknown) {
    const runId = typeof raw === 'object' && raw !== null ? (raw as { runId?: unknown }).runId : undefined
    const sub = typeof runId === 'string' ? this.subs.get(runId) : undefined
    if (!sub) return
    const r = sub.feed.push(raw)
    for (const out of r.out) {
      if (out.kind === 'reload') { this.reload(); return }
      sub.onFrame({ runId: out.runId, seq: out.seq, at: out.at as RunFrame['at'], event: out.event })
    }
    if (r.reattachFrom !== null && this.subs.get(sub.feed.runId) === sub) this.attachFrom(sub.feed.runId, sub, r.reattachFrom)
  }

  private reload() {
    this.setLink('reload')
    this.subs.clear()
    this.shut()
  }

  private closed(code: number) {
    this.ws = null; this.opened = false
    const out = closeOutcome(code)
    if (this.subs.size === 0) { this.shut(); return }
    switch (out.kind) {
      case 'grantEnded':
        this.subs.clear(); this.shut(); this.setLink('grantEnded'); this.o.onGrantEnded(); return
      case 'reload': this.reload(); return
      case 'reauth': {
        this.setLink('held')
        const epoch = this.epoch
        void this.o.onReauth().then(ok => {
          if (epoch !== this.epoch) return
          if (ok) this.drop(0); else { this.subs.clear(); this.shut(); this.setLink('live') }
        }, () => { if (epoch === this.epoch) this.drop() })
        return
      }
      case 'held': case 'reconnect': this.drop(); return
    }
  }

  /** Waits, then connects again (the wait grows to 10 s while it keeps failing). */
  private drop(ms?: number) {
    this.setLink('held')
    const at = ms ?? this.wait
    this.wait = Math.min(this.wait * 2, WAIT_MAX_MS)
    const epoch = this.epoch
    this.timer = (this.o.after ?? ((fn, t) => setTimeout(fn, t)))(() => {
      this.timer = null
      if (epoch === this.epoch && this.subs.size > 0 && !this.ws) this.connect()
    }, at)
  }
}
