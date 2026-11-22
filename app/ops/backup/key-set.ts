// A compact, read-after-write set of keys for the backup's FK closure check (P8 C1). Each key is kept as a 53-bit hash
// in a Float64Array, sorted once the set first answers: 8 bytes a key, against roughly 80 for a string in a Set. A
// missing key reads as present only if its hash equals one of n stored hashes: about n / 2^53 (1e-10 at a million keys).
// It never reads a present key as absent. Keys are added while their table is read and looked up only after (restore
// order puts every parent first), so adding after the first lookup throws.

/** Two 32-bit FNV-1a passes with different offsets, mixed (murmur3's finaliser), joined into 53 bits. */
function hash53(key: string): number {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
  }
  const mix = (h: number) => {
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
    return (h ^ (h >>> 16)) >>> 0
  }
  return (mix(a) & 0x1fffff) * 0x100000000 + mix(b)
}

export class KeySet {
  private pending: number[] = []
  private sorted: Float64Array | null = null

  add(key: string): void {
    if (this.sorted !== null) throw new Error('KeySet: sealed (a key added after the set first answered)')
    this.pending.push(hash53(key))
  }

  has(key: string): boolean {
    if (this.sorted === null) {
      this.sorted = Float64Array.from(this.pending).sort()
      this.pending = []
    }
    const h = hash53(key)
    let lo = 0
    let hi = this.sorted.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1
      const v = this.sorted[mid]
      if (v === h) return true
      if (v < h) lo = mid + 1
      else hi = mid - 1
    }
    return false
  }

  /** The bytes the sealed set holds (8 a key). */
  get bytes(): number {
    return (this.sorted?.length ?? this.pending.length) * 8
  }
}
