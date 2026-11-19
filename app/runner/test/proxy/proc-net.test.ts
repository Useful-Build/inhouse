// The /proc/net/tcp* parser and the peer lookup. Ways they could fail, written first:
// - an address decodes in the wrong byte order (IPv4 words are little-endian on our hosts);
// - IPv6 text differs from how Node reports the same address, so a real caller never matches;
// - a v4-mapped IPv6 entry doesn't match the IPv4 address Node gives;
// - a garbage or header line parses, or throws;
// - the lookup matches the proxy's own (root-owned) socket, a listening socket, or one of several ambiguous entries.
import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { decodeAddress, findPeerUid, normaliseAddress, parseProcNetTcp, type TcpEntry } from '../../src/proxy/proc-net.ts'

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
const hex = (n: number, w: number) => n.toString(16).toUpperCase().padStart(w, '0')
/** The kernel's encoding: each 32-bit word's bytes reversed (little-endian host). */
const word = (b: number[]) => [...b].reverse().map((x) => hex(x, 2)).join('')
const v4hex = (bytes: number[]) => word(bytes)
const v6hex = (bytes: number[]) => [0, 4, 8, 12].map((i) => word(bytes.slice(i, i + 4))).join('')
const line = (i: number, l: string, lp: number, r: string, rp: number, st: number, uid: number) =>
  `${String(i).padStart(4)}: ${l}:${hex(lp, 4)} ${r}:${hex(rp, 4)} ${hex(st, 2)} 00000000:00000000 00:00000000 00000000 ${String(uid).padStart(5)}        0 12345 1 0000000000000000 20 4 30 10 -1`

const byte = fc.integer({ min: 0, max: 255 })
const port = fc.integer({ min: 1, max: 65535 })
const uid = fc.integer({ min: 0, max: 2 ** 31 })

describe('parseProcNetTcp', () => {
  it('reads a real-looking IPv4 table', () => {
    const text = `${HEADER}\n   0: 0100007F:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0 100 0 0 10 0\n   1: 0100007F:D2A4 0100007F:1F91 01 00000000:00000000 00:00000000 00000000  1001        0 2 1 0 20 4 30 10 -1\n`
    expect(parseProcNetTcp(text)).toEqual([
      { local: { address: '127.0.0.1', port: 8081 }, remote: { address: '0.0.0.0', port: 0 }, state: 10, uid: 0 },
      { local: { address: '127.0.0.1', port: 53924 }, remote: { address: '127.0.0.1', port: 8081 }, state: 1, uid: 1001 },
    ])
  })

  it.prop([fc.array(byte, { minLength: 4, maxLength: 4 }), port, fc.array(byte, { minLength: 4, maxLength: 4 }), port, fc.integer({ min: 1, max: 11 }), uid])(
    'IPv4 entries decode to the address and port that were encoded',
    (l, lp, r, rp, st, u) => {
      const [e] = parseProcNetTcp(line(0, v4hex(l), lp, v4hex(r), rp, st, u))
      expect(e).toEqual({ local: { address: l.join('.'), port: lp }, remote: { address: r.join('.'), port: rp }, state: st, uid: u })
    },
  )

  it.prop([fc.array(byte, { minLength: 16, maxLength: 16 }), port, uid])('IPv6 entries decode the way Node writes the address', (bytes, p, u) => {
    const [e] = parseProcNetTcp(line(0, v6hex(bytes), p, v6hex(bytes), p, 1, u))
    const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255
    // Node's own canonical text for the same 16 bytes (WHATWG URL serialisation, RFC 5952 compression).
    const groups = Array.from({ length: 8 }, (_, i) => ((bytes[2 * i]! << 8) | bytes[2 * i + 1]!).toString(16)).join(':')
    const nodeText = new URL(`http://[${groups}]/`).hostname.slice(1, -1)
    expect(e!.local.address).toBe(mapped ? bytes.slice(12).join('.') : nodeText)
    expect(normaliseAddress(nodeText)).toBe(e!.local.address)
  })

  it('reads ::1 and a v4-mapped loopback', () => {
    expect(decodeAddress('00000000000000000000000001000000')).toBe('::1')
    expect(decodeAddress('0000000000000000FFFF00000100007F')).toBe('127.0.0.1')
    expect(normaliseAddress('::ffff:127.0.0.1')).toBe('127.0.0.1')
    expect(normaliseAddress('::1')).toBe('::1')
  })

  it.prop([fc.string()])('skips garbage lines without throwing', (junk) => {
    const good = line(1, v4hex([127, 0, 0, 1]), 5000, v4hex([127, 0, 0, 1]), 8081, 1, 42)
    const entries = parseProcNetTcp(`${HEADER}\n${junk}\n${good}\n`)
    expect(entries.at(-1)).toEqual({ local: { address: '127.0.0.1', port: 5000 }, remote: { address: '127.0.0.1', port: 8081 }, state: 1, uid: 42 })
  })

  it('skips malformed fields', () => {
    for (const bad of [
      '   0: 0100007G:1F91 0100007F:D2A4 01 0 0 0 1000 0',
      '   0: 0100007F:1F9 0100007F:D2A4 01 0 0 0 1000 0',
      '   0: 0100007F1F91 0100007F:D2A4 01 0 0 0 1000 0',
      '   0: 0100007F:1F91 0100007F:D2A4 01 0 0 0 -5 0',
      '   0: 0100007F:1F91 0100007F:D2A4',
      'x0: 0100007F:1F91 0100007F:D2A4 01 0 0 0 1000 0',
    ])
      expect(parseProcNetTcp(bad)).toEqual([])
  })
})

describe('findPeerUid', () => {
  const proxy = { address: '127.0.0.1', port: 8081 }
  const client = { address: '127.0.0.1', port: 53924 }
  const conn = { localAddress: '127.0.0.1', localPort: 8081, remoteAddress: '127.0.0.1', remotePort: 53924 }
  const listening: TcpEntry = { local: proxy, remote: { address: '0.0.0.0', port: 0 }, state: 10, uid: 0 }
  const proxySide: TcpEntry = { local: proxy, remote: client, state: 1, uid: 0 }
  const clientSide: TcpEntry = { local: client, remote: proxy, state: 1, uid: 1001 }

  it("finds the client's uid, not the proxy's own socket", () => {
    expect(findPeerUid([listening, proxySide, clientSide], conn)).toBe(1001)
  })

  it('a v4-mapped connection matches the IPv4 entry', () => {
    expect(findPeerUid([clientSide], { ...conn, localAddress: '::ffff:127.0.0.1', remoteAddress: '::ffff:127.0.0.1' })).toBe(1001)
  })

  it('no match, a non-established match, or two matches: null', () => {
    expect(findPeerUid([listening, proxySide], conn)).toBeNull()
    expect(findPeerUid([{ ...clientSide, state: 6 }], conn)).toBeNull()
    expect(findPeerUid([clientSide, { ...clientSide, uid: 1002 }], conn)).toBeNull()
  })

  it.prop([fc.array(fc.record({ lp: port, rp: port, u: uid }), { maxLength: 20 }), port, uid])(
    'only an entry with both ends swapped matches',
    (others, cp, u) => {
      const entries: TcpEntry[] = others
        .filter((o) => !(o.lp === cp && o.rp === 8081))
        .map((o) => ({ local: { address: '127.0.0.1', port: o.lp }, remote: { address: '127.0.0.1', port: o.rp }, state: 1, uid: o.u }))
      const c = { ...conn, remotePort: cp }
      expect(findPeerUid(entries, c)).toBeNull()
      entries.push({ local: { address: '127.0.0.1', port: cp }, remote: proxy, state: 1, uid: u })
      expect(findPeerUid(entries, c)).toBe(u)
    },
  )
})
