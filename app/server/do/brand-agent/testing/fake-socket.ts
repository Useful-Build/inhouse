// A hibernatable WebSocket as the socket hub sees it (sockets.ts `HubSocket`), for tests: it keeps what was sent (parsed),
// how it was closed, and its attachment as the runtime would (serialized, refused over 16,384 bytes). Sending on a
// socket the server closed throws, as a closed socket can't carry a frame.
import type { SocketServerMsg } from '../../../../shared/contract/runs.ts'
import type { HubSocket } from '../sockets.ts'

export class FakeSocket implements HubSocket {
  out: SocketServerMsg[] = []
  closed: { code: number; reason: string } | null = null
  private att: string | null = null
  /** Set when the browser side went away (the runtime no longer lists it). */
  gone = false
  readonly name: string
  constructor(name: string) { this.name = name }
  send(message: string) {
    if (this.closed || this.gone) throw new Error('send on a closed socket')
    this.out.push(JSON.parse(message) as SocketServerMsg)
  }
  close(code = 1000, reason = '') {
    if (this.closed) throw new Error('closed twice')
    this.closed = { code, reason }
  }
  serializeAttachment(value: unknown) {
    const s = JSON.stringify(value)
    if (new TextEncoder().encode(s).byteLength > 16_384) throw new Error('attachment over 16,384 bytes')
    this.att = s
  }
  deserializeAttachment(): unknown { return this.att === null ? null : JSON.parse(this.att) }
  /** What arrived, one line each: `frame <seq> <event type>`, `attached <lastSeq> <live|ended>`, `refused <code>`. */
  lines(): string[] {
    return this.out.map(m => m.type === 'frame' ? `frame ${m.frame.seq} ${(m.frame.event as { type: string }).type}`
      : m.type === 'attached' ? `attached ${m.lastSeq} ${m.live ? 'live' : 'ended'}` : `refused ${m.code}`)
  }
  /** The seqs of the frames that arrived, in order. */
  seqs(): number[] { return this.out.flatMap(m => (m.type === 'frame' ? [m.frame.seq] : [])) }
  take(): string[] { const l = this.lines(); this.out = []; return l }
}
