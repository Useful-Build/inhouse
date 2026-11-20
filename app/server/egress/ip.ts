// Whether an address is public (p3-design 8.8): WebFetch refuses private, loopback, link-local, CGNAT, multicast,
// unspecified, cloud-metadata, documentation and reserved addresses, and every IPv4-mapped or -embedding IPv6 form.
// IPv6 is public only inside 2000::/3 (global unicast) and outside its special blocks. Ranges: the IANA special-purpose
// registries (IPv4 RFC 6890 and IPv6 RFC 6890 / RFC 4291), read 2026-11-20.

/** An IPv4 address as four bytes, or null (dotted decimal only: the URL parser already normalised other forms). */
export function parseIPv4(s: string): number[] | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/** An IPv6 address as eight 16-bit groups (a trailing dotted IPv4 allowed), or null. */
export function parseIPv6(input: string): number[] | null {
  let s = input.toLowerCase()
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  if (s.includes('%')) return null
  let tail: number[] = []
  const lastColon = s.lastIndexOf(':')
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(s.slice(lastColon + 1))
    if (!v4) return null
    tail = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!]
    s = `${s.slice(0, lastColon + 1)}x`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (h: string) => (h === '' ? [] : h.split(':'))
  const head = groups(halves[0]!)
  const back = halves.length === 2 ? groups(halves[1]!) : []
  const toNums = (gs: string[]) => {
    const out: number[] = []
    for (const g of gs) {
      if (g === 'x') {
        out.push(...tail)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const h = toNums(head)
  const b = toNums(back)
  if (!h || !b) return null
  if (halves.length === 1) return h.length === 8 ? h : null
  const fill = 8 - h.length - b.length
  if (fill < 1) return null
  return [...h, ...new Array<number>(fill).fill(0), ...b]
}

const inV4 = (a: number[], base: number[], bits: number) => {
  const toInt = (x: number[]) => ((x[0]! << 24) | (x[1]! << 16) | (x[2]! << 8) | x[3]!) >>> 0
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((toInt(a) & mask) >>> 0) === ((toInt(base) & mask) >>> 0)
}

const V4_BLOCKED: [number[], number][] = [
  [[0, 0, 0, 0], 8], // "this network", unspecified
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, cloud metadata (169.254.169.254)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, broadcast
]

export function isPublicIPv4(a: number[]): boolean {
  return !V4_BLOCKED.some(([base, bits]) => inV4(a, base, bits))
}

/** The first `bits` bits of two group lists agree. */
const inV6 = (a: number[], base: number[], bits: number) => {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const m = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff
    if ((a[i]! & m) !== (base[i]! & m)) return false
  }
  return true
}

const V6_BLOCKED: [number[], number][] = [
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 23], // IETF protocol assignments (Teredo 2001::/32 inside)
  [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32], // documentation
  [[0x2002, 0, 0, 0, 0, 0, 0, 0], 16], // 6to4 (embeds an IPv4 address)
  [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20], // documentation (RFC 9637)
]

export function isPublicIPv6(a: number[]): boolean {
  // Global unicast only: this leaves out ::, ::1, ::ffff:0:0/96 (mapped), 64:ff9b::/96 (NAT64), fc00::/7 (unique local,
  // AWS's fd00:ec2::254 metadata), fe80::/10 (link-local), ff00::/8 (multicast) and every other reserved block.
  if ((a[0]! & 0xe000) !== 0x2000) return false
  return !V6_BLOCKED.some(([base, bits]) => inV6(a, base, bits))
}

/** An address literal's verdict: `public`, `blocked`, or null when it isn't an address at all. */
export function addressVerdict(host: string): 'public' | 'blocked' | null {
  const v4 = parseIPv4(host)
  if (v4) return isPublicIPv4(v4) ? 'public' : 'blocked'
  if (host.includes(':')) {
    const v6 = parseIPv6(host)
    if (!v6) return 'blocked'
    return isPublicIPv6(v6) ? 'public' : 'blocked'
  }
  return null
}
