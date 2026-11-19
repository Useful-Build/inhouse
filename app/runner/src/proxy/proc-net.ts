// Finds the OS user on the other end of a loopback TCP connection from the kernel's socket tables
// (/proc/net/tcp and /proc/net/tcp6). The parser is pure so it can be tested anywhere; `readPeerUid` is the thin reader.
//
// A table line looks like:
//   sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode ...
//    0: 0100007F:1F90 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000        0 12345 ...
// Addresses are the raw in-kernel bytes printed as 32-bit words in host byte order. The container runs on
// little-endian hosts (x86_64, arm64), so each word's bytes are reversed. Ports are big-endian hex.
import { readFile } from 'node:fs/promises'

export type Endpoint = { address: string; port: number }
export type TcpEntry = { local: Endpoint; remote: Endpoint; state: number; uid: number }

/** TCP_ESTABLISHED in the kernel's state numbering. */
export const ESTABLISHED = 1

export type Conn = { localAddress: string; localPort: number; remoteAddress: string; remotePort: number }

function word(hex8: string): number[] {
  // One 32-bit word in little-endian host order: the bytes, low first.
  const b = [0, 2, 4, 6].map((i) => Number.parseInt(hex8.slice(i, i + 2), 16))
  return b.reverse()
}

/** Decodes a table address (8 hex chars for IPv4, 32 for IPv6) to its usual text form; v4-mapped IPv6 becomes IPv4. */
export function decodeAddress(hex: string): string | null {
  if (!/^[0-9A-Fa-f]+$/.test(hex)) return null
  if (hex.length === 8) return word(hex).join('.')
  if (hex.length !== 32) return null
  const bytes = [0, 8, 16, 24].flatMap((i) => word(hex.slice(i, i + 8)))
  return ipv6Text(bytes)
}

function ipv6Text(bytes: number[]): string {
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (mapped) return bytes.slice(12).join('.')
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i]! << 8) | bytes[i + 1]!)
  return canonicalIpv6(groups)
}

/** RFC 5952 text: lowercase, no leading zeros, the longest run (2+) of zero groups as `::`. */
function canonicalIpv6(groups: number[]): string {
  let best = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen && j - i >= 2) {
      best = i
      bestLen = j - i
    }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (best < 0) return hex.join(':')
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`
}

/** Normalises an address as Node reports it on a socket, so it compares equal to `decodeAddress`'s output. */
export function normaliseAddress(address: string): string | null {
  const lower = address.toLowerCase()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower)
  if (mapped) return mapped[1]!
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(lower)) return lower
  if (!lower.includes(':')) return null
  // Expand, then re-canonicalise.
  const [head, tail, extra] = lower.split('::')
  if (extra !== undefined) return null
  const parse = (s: string | undefined) => (s ? s.split(':') : [])
  const h = parse(head)
  const t = tail === undefined ? [] : parse(tail)
  const missing = 8 - h.length - t.length
  if (tail === undefined ? h.length !== 8 : missing < 1) return null
  const all = [...h, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...t]
  if (!all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null
  return canonicalIpv6(all.map((g) => Number.parseInt(g, 16)))
}

function endpoint(field: string | undefined): Endpoint | null {
  const m = /^([0-9A-Fa-f]{8}|[0-9A-Fa-f]{32}):([0-9A-Fa-f]{4})$/.exec(field ?? '')
  if (!m) return null
  const address = decodeAddress(m[1]!)
  return address === null ? null : { address, port: Number.parseInt(m[2]!, 16) }
}

/** Parses a /proc/net/tcp or /proc/net/tcp6 table. Lines it can't read (the header, garbage) are skipped. */
export function parseProcNetTcp(text: string): TcpEntry[] {
  const out: TcpEntry[] = []
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 8 || !/^\d+:$/.test(f[0]!)) continue
    const local = endpoint(f[1])
    const remote = endpoint(f[2])
    if (!local || !remote || !/^[0-9A-Fa-f]{2}$/.test(f[3]!) || !/^\d+$/.test(f[7]!)) continue
    out.push({ local, remote, state: Number.parseInt(f[3]!, 16), uid: Number(f[7]) })
  }
  return out
}

/** The table entries for the client end of a connection we accepted (its local and remote are ours swapped). */
function clientEnds(entries: TcpEntry[], conn: Conn): TcpEntry[] | null {
  const ours = normaliseAddress(conn.localAddress)
  const client = normaliseAddress(conn.remoteAddress)
  if (ours === null || client === null) return null
  return entries.filter(
    (e) => e.local.address === client && e.local.port === conn.remotePort && e.remote.address === ours && e.remote.port === conn.localPort,
  )
}

/**
 * The uid owning the client end of a connection the proxy accepted. The proxy's socket has local = the proxy, remote =
 * the client; the client's own socket is the table entry with those swapped. Exactly one established match, or null.
 */
export function findPeerUid(entries: TcpEntry[], conn: Conn): number | null {
  const matches = clientEnds(entries, conn)?.filter((e) => e.state === ESTABLISHED) ?? []
  return matches.length === 1 ? matches[0]!.uid : null
}

const isLoopback = (address: string) => address.startsWith('127.') || address === '::1'

/**
 * Whether the root's API (port 8080) may serve a connection. A peer with no socket in this machine's tables is the
 * Worker (it connects from outside the container) and is allowed. A local peer is allowed only when every client end
 * found is root's and established; a session user's process (its Bash, say) is refused. Fails closed on what it can't
 * read: an address it can't parse, or a loopback peer whose socket isn't in the tables (it has already gone).
 */
export function decideApiPeer(entries: TcpEntry[], conn: Conn): 'allow' | 'refuse' {
  const ends = clientEnds(entries, conn)
  if (ends === null) return 'refuse'
  if (ends.length === 0) return isLoopback(normaliseAddress(conn.remoteAddress)!) ? 'refuse' : 'allow'
  return ends.every((e) => e.uid === 0 && e.state === ESTABLISHED) ? 'allow' : 'refuse'
}

type SocketLike = { localAddress?: string; localPort?: number; remoteAddress?: string; remotePort?: number }

function connOf(s: SocketLike): Conn | null {
  if (!s.localAddress || !s.remoteAddress || !s.localPort || !s.remotePort) return null
  return { localAddress: s.localAddress, localPort: s.localPort, remoteAddress: s.remoteAddress, remotePort: s.remotePort }
}

/** Reads both tables (as root), without blocking the event loop. Throws when a table can't be read. */
export async function readTcpTables(): Promise<TcpEntry[]> {
  const texts = await Promise.all(['/proc/net/tcp', '/proc/net/tcp6'].map((p) => readFile(p, 'utf8')))
  return texts.flatMap(parseProcNetTcp)
}

/** The peer's uid. Null when the connection isn't found exactly once. */
export async function readPeerUid(socket: SocketLike): Promise<number | null> {
  const conn = connOf(socket)
  return conn === null ? null : findPeerUid(await readTcpTables(), conn)
}

/** The production `apiPeerAllowed` for the root's API. */
export async function apiPeerAllowed(socket: SocketLike): Promise<boolean> {
  const conn = connOf(socket)
  return conn !== null && decideApiPeer(await readTcpTables(), conn) === 'allow'
}
