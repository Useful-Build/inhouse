// Finds the OS user on the other end of a loopback TCP connection from the kernel's socket tables
// (/proc/net/tcp and /proc/net/tcp6). The parser is pure so it can be tested anywhere; `readPeerUid` is the thin reader.
//
// A table line looks like:
//   sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode ...
//    0: 0100007F:1F90 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000        0 12345 ...
// Addresses are the raw in-kernel bytes printed as 32-bit words in host byte order. The container runs on
// little-endian hosts (x86_64, arm64), so each word's bytes are reversed. Ports are big-endian hex.
import { readFileSync } from 'node:fs'

export type Endpoint = { address: string; port: number }
export type TcpEntry = { local: Endpoint; remote: Endpoint; state: number; uid: number }

/** TCP_ESTABLISHED in the kernel's state numbering. */
export const ESTABLISHED = 1

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

/**
 * The uid owning the client end of a connection the proxy accepted. The proxy's socket has local = the proxy, remote =
 * the client; the client's own socket is the table entry with those swapped. Exactly one established match, or null.
 */
export function findPeerUid(entries: TcpEntry[], conn: { localAddress: string; localPort: number; remoteAddress: string; remotePort: number }): number | null {
  const proxy = normaliseAddress(conn.localAddress)
  const client = normaliseAddress(conn.remoteAddress)
  if (proxy === null || client === null) return null
  const matches = entries.filter(
    (e) =>
      e.state === ESTABLISHED &&
      e.local.address === client &&
      e.local.port === conn.remotePort &&
      e.remote.address === proxy &&
      e.remote.port === conn.localPort,
  )
  return matches.length === 1 ? matches[0]!.uid : null
}

/** Reads both tables (as root) and finds the peer's uid. Null when the connection isn't found exactly once. */
export function readPeerUid(conn: { localAddress?: string; localPort?: number; remoteAddress?: string; remotePort?: number }): number | null {
  if (!conn.localAddress || !conn.remoteAddress || !conn.localPort || !conn.remotePort) return null
  const entries = ['/proc/net/tcp', '/proc/net/tcp6'].flatMap((p) => parseProcNetTcp(readFileSync(p, 'utf8')))
  return findPeerUid(entries, { localAddress: conn.localAddress, localPort: conn.localPort, remoteAddress: conn.remoteAddress, remotePort: conn.remotePort })
}
