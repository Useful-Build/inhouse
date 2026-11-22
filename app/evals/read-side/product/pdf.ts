// The PDF reader, a strict allowlist: a file is read only when every byte that matters is accounted for, and is null otherwise.
// It parses the file as a sequence of top-level tokens (indirect objects with their streams, xref sections, trailers, startxref)
// with PDF white space (NUL, tab, LF, FF, CR, space) and comments skipped; anything else at the top level is null. Every object
// is parsed whole (dictionaries with no repeated key, arrays, strings, names with their #xx escapes, numbers, references).
// Each stream is the bytes its /Length says, then an end of line and `endstream`, and is read by what it is:
//   - an object stream (/Type /ObjStm, never with an image or font marker): decoded and every object in it parsed;
//   - a cross-reference stream (/Type /XRef): decoded, predictor applied, every entry checked;
//   - an image (/Subtype /Image): pixels; its text filters must still decode in full, an image codec only last;
//   - a font program, XMP metadata, an ICC profile: data, decoded in full and not scanned;
//   - anything else (page content, forms, XFA): decoded and lexed (strings, names, comments, inline images).
// Filters: FlateDecode (to the zlib end: bytes after it, or a cut stream, are null; PNG predictors applied, TIFF's null),
// ASCII85Decode and ASCIIHexDecode, each reading its input in full. Every classic or stream xref offset, startxref, /Prev,
// /XRefStm, /Root and /Info must land on an object start or xref section this parser read, outside any stream. An object number
// defined twice (incremental updates included), an ObjStm-shaped stream that isn't typed as one, an xref entry into a stream
// that isn't an object stream, and encryption are null.
// Detection walks every parsed object and every lexed content stream: an action name anywhere is an action; rich media, XFA,
// embedded files and a URL file specification (in any key order) are external references; a /URI string is a link (an indirect
// one is resolved); an indirect /S must resolve to a name, an indirect /OpenAction or /AA to a dictionary or array, or null.
import { inflateSync } from 'node:zlib'
import type { FileEvidence } from '../grade.ts'

type Reference = FileEvidence['references'][number]
type Dict = { t: 'dict'; m: Map<string, Value> }
type Value = number | boolean | null | { t: 'name'; v: string } | { t: 'str'; v: string } | { t: 'ref'; n: number; g: number } | Value[] | Dict

class Reject extends Error {}
const reject = (why: string): never => { throw new Reject(why) }

/** Caps: bytes inflated per stream, objects in an object stream. */
export const PDF_CAPS = { inflated: 32 * 1024 * 1024, objStmObjects: 100_000 }

const isWs = (c: string | undefined) => c === '\0' || c === '\t' || c === '\n' || c === '\f' || c === '\r' || c === ' '
const isDelim = (c: string | undefined) => c !== undefined && '()<>[]{}/%'.includes(c)
const isRegular = (c: string | undefined) => c !== undefined && !isWs(c) && !isDelim(c)
const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1')

class Lexer {
  i = 0
  readonly s: string
  constructor(s: string) {
    this.s = s
  }
  skipWs(): void {
    for (;;) {
      const c = this.s[this.i]
      if (isWs(c)) this.i++
      else if (c === '%') {
        while (this.i < this.s.length && this.s[this.i] !== '\n' && this.s[this.i] !== '\r') this.i++
      } else return
    }
  }
  /** The run of regular characters at the cursor (a keyword or a number), not consumed. */
  peekToken(): string {
    let j = this.i
    while (isRegular(this.s[j])) j++
    return this.s.slice(this.i, j)
  }
  keyword(k: string): boolean {
    if (this.peekToken() !== k) return false
    this.i += k.length
    return true
  }
  int(): number {
    const t = this.peekToken()
    if (!/^\d{1,12}$/.test(t)) reject(`expected an integer at ${this.i}`)
    this.i += t.length
    return Number(t)
  }
  literal(): string {
    // At '(': balanced parentheses, backslash escapes decoded.
    let depth = 0
    let out = ''
    for (let j = this.i; j < this.s.length; j++) {
      const c = this.s[j]!
      if (c === '\\') {
        const e = this.s[j + 1]
        if (e === undefined) break
        const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
        if (e in map) { out += map[e]; j++ }
        else if (/[0-7]/.test(e)) {
          const oct = /^[0-7]{1,3}/.exec(this.s.slice(j + 1, j + 4))![0]
          out += String.fromCharCode(parseInt(oct, 8) & 0xff)
          j += oct.length
        } else if (e === '\r' || e === '\n') { j += e === '\r' && this.s[j + 2] === '\n' ? 2 : 1 }
        else { out += e; j++ }
        continue
      }
      if (c === '(') { if (depth++ > 0) out += c; continue }
      if (c === ')') {
        if (--depth === 0) { this.i = j + 1; return out }
        out += c
        continue
      }
      out += c
    }
    return reject('a literal string never closes')
  }
  hex(): string {
    // At '<' (not '<<'): hex digits and white space up to '>'.
    const end = this.s.indexOf('>', this.i)
    if (end < 0) reject('a hex string never closes')
    const body = this.s.slice(this.i + 1, end)
    if (!/^[0-9A-Fa-f\0\t\n\f\r ]*$/.test(body)) reject('a hex string holds a non-hex character')
    this.i = end + 1
    const h = body.replace(/[\0\t\n\f\r ]/g, '')
    return Buffer.from(h.length % 2 ? `${h}0` : h, 'hex').toString('latin1')
  }
  name(): string {
    // At '/': regular characters, #xx escapes decoded; a broken escape, or one decoding to white space, a delimiter or a
    // control character, reads two ways: null.
    let j = this.i + 1
    while (isRegular(this.s[j])) j++
    const raw = this.s.slice(this.i + 1, j)
    if (/#(?![0-9A-Fa-f]{2})/.test(raw)) reject('a name has a broken #xx escape')
    const v = raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    if ([...v].some((c) => isWs(c) || isDelim(c) || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) reject('a name decodes to a delimiter or white space')
    this.i = j
    return v
  }
  value(depth = 0): Value {
    if (depth > 100) reject('nesting deeper than 100')
    this.skipWs()
    const c = this.s[this.i]
    if (c === '<' && this.s[this.i + 1] === '<') {
      this.i += 2
      const m = new Map<string, Value>()
      for (;;) {
        this.skipWs()
        if (this.s[this.i] === '>' && this.s[this.i + 1] === '>') { this.i += 2; return { t: 'dict', m } }
        if (this.s[this.i] !== '/') reject(`a dictionary key isn't a name at ${this.i}`)
        const k = this.name()
        if (m.has(k)) reject(`a dictionary repeats /${k}`)
        m.set(k, this.value(depth + 1))
      }
    }
    if (c === '<') return { t: 'str', v: this.hex() }
    if (c === '(') return { t: 'str', v: this.literal() }
    if (c === '[') {
      this.i++
      const a: Value[] = []
      for (;;) {
        this.skipWs()
        if (this.s[this.i] === ']') { this.i++; return a }
        if (this.i >= this.s.length) reject('an array never closes')
        a.push(this.value(depth + 1))
      }
    }
    if (c === '/') return { t: 'name', v: this.name() }
    const tok = this.peekToken()
    if (tok === 'true' || tok === 'false') { this.i += tok.length; return tok === 'true' }
    if (tok === 'null') { this.i += 4; return null }
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(tok)) reject(`unexpected ${JSON.stringify(tok.slice(0, 20) || c)} at ${this.i}`)
    this.i += tok.length
    // `N G R` is a reference.
    if (/^\d+$/.test(tok)) {
      const save = this.i
      this.skipWs()
      const g = this.peekToken()
      if (/^\d+$/.test(g)) {
        this.i += g.length
        this.skipWs()
        if (this.keyword('R')) return { t: 'ref', n: Number(tok), g: Number(g) }
      }
      this.i = save
    }
    return Number(tok)
  }
}

const isDict = (v: Value | undefined): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'dict'
const nameOf = (v: Value | undefined): string | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'name' ? v.v : undefined)
const strOf = (v: Value | undefined): string | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'str' ? v.v : undefined)
const refOf = (v: Value | undefined) => (typeof v === 'object' && v !== null && !Array.isArray(v) && v.t === 'ref' ? v : undefined)
const intOf = (v: Value | undefined): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined)

/** ASCII85 (Adobe): groups of five, `z` for four zero bytes, white space ignored, `~>` at the end. Null on anything else. */
export function ascii85(data: Uint8Array): Uint8Array | null {
  const text = latin1(data).replace(/[\0\t\n\f\r ]+/g, '')
  const endAt = text.indexOf('~>')
  if (endAt < 0 || text.slice(endAt + 2) !== '') return null
  const body = text.slice(text.startsWith('<~') ? 2 : 0, endAt)
  const out: number[] = []
  let group: number[] = []
  const flush = (count: number) => {
    let n = 0
    for (const d of [...group, ...Array(5 - group.length).fill(84)]) n = n * 85 + d
    if (n > 0xffffffff) return false
    for (let k = 0; k < count; k++) out.push((n >>> (24 - 8 * k)) & 0xff)
    return true
  }
  for (const ch of body) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue }
    const d = ch.charCodeAt(0) - 33
    if (d < 0 || d > 84) return null
    group.push(d)
    if (group.length === 5) { if (!flush(4)) return null; group = [] }
  }
  if (group.length === 1) return null
  if (group.length > 0 && !flush(group.length - 1)) return null
  return Uint8Array.from(out)
}
/** ASCIIHex: hex digits, white space ignored, `>` at the end (an odd last digit is padded with 0). Null on anything else. */
export function asciiHex(data: Uint8Array): Uint8Array | null {
  const text = latin1(data).replace(/[\0\t\n\f\r ]+/g, '')
  if (!text.endsWith('>') || !/^[0-9A-Fa-f]*$/.test(text.slice(0, -1))) return null
  const hex = text.slice(0, -1)
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')
}
/** Flate to the zlib end: nothing may follow it but one end of line, and a cut stream is null. */
function flate(data: Uint8Array): Uint8Array | null {
  try {
    const r = inflateSync(data, { info: true, maxOutputLength: PDF_CAPS.inflated }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
    const rest = latin1(data.subarray(r.engine.bytesWritten))
    return /^(?:\r\n|\r|\n)?$/.test(rest) ? r.buffer : null
  } catch {
    return null
  }
}
/** PNG predictors (10 to 15): each row starts with its filter type (None, Sub, Up, Average, Paeth). Null on a ragged length or a bad type. */
function unpredictPng(data: Uint8Array, parms: Dict): Uint8Array | null {
  const colors = intOf(parms.m.get('Colors')) ?? 1
  const bpc = intOf(parms.m.get('BitsPerComponent')) ?? 8
  const columns = intOf(parms.m.get('Columns')) ?? 1
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)
  if (rowLen <= 0 || data.length % (rowLen + 1) !== 0) return null
  const out = new Uint8Array((data.length / (rowLen + 1)) * rowLen)
  let prev = new Uint8Array(rowLen)
  for (let r = 0; r * (rowLen + 1) < data.length; r++) {
    const type = data[r * (rowLen + 1)]!
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1))
    const cur = new Uint8Array(rowLen)
    for (let x = 0; x < rowLen; x++) {
      const a = x >= bpp ? cur[x - bpp]! : 0
      const b = prev[x]!
      const c = x >= bpp ? prev[x - bpp]! : 0
      let pred: number
      if (type === 0) pred = 0
      else if (type === 1) pred = a
      else if (type === 2) pred = b
      else if (type === 3) pred = Math.floor((a + b) / 2)
      else if (type === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      } else return null
      cur[x] = (row[x]! + pred) & 0xff
    }
    out.set(cur, r * rowLen)
    prev = cur
  }
  return out
}
const IMAGE_CODECS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode'])

/** A stream's bytes through its filters, or null. `pixels`: the stream is an image, so an image codec may come last (and stops decoding). */
function decode(dict: Dict, data: Uint8Array, pixels: boolean): Uint8Array | 'pixels' | null {
  const f = dict.m.get('Filter')
  const filters = f === undefined ? [] : nameOf(f) !== undefined ? [nameOf(f)!] : Array.isArray(f) && f.length <= 3 && f.every((x) => nameOf(x) !== undefined) ? f.map((x) => nameOf(x)!) : null
  if (filters === null) return null
  const p = dict.m.get('DecodeParms')
  const parms: (Dict | null)[] = p === undefined || p === null ? filters.map(() => null) : isDict(p) && filters.length === 1 ? [p] : Array.isArray(p) && p.length === filters.length && p.every((x) => x === null || isDict(x)) ? (p as (Dict | null)[]) : []
  if (parms.length !== filters.length) return null
  let out: Uint8Array | null = data
  for (let k = 0; k < filters.length && out !== null; k++) {
    const name = filters[k]!
    if (IMAGE_CODECS.has(name)) return pixels && k === filters.length - 1 ? 'pixels' : null
    if (name === 'FlateDecode') {
      out = flate(out)
      const predictor = parms[k] ? intOf(parms[k]!.m.get('Predictor')) ?? 1 : 1
      if (out !== null && predictor >= 10 && predictor <= 15) out = unpredictPng(out, parms[k]!)
      else if (predictor !== 1) return null
    } else if (name === 'ASCII85Decode') out = ascii85(out)
    else if (name === 'ASCIIHexDecode') out = asciiHex(out)
    else return null
  }
  return out
}

/** A content stream's text with names decoded, strings decoded and kept in parentheses, comments dropped, inline image data skipped. */
function lexContent(s: string): { text: string; names: string[] } {
  const L = new Lexer(s)
  const parts: string[] = []
  const names: string[] = []
  for (;;) {
    L.skipWs()
    if (L.i >= s.length) break
    const c = s[L.i]
    if (c === '(') parts.push(`(${L.literal().replace(/[\\()]/g, (x) => `\\${x}`)})`)
    else if (c === '<' && s[L.i + 1] === '<') { parts.push('<<'); L.i += 2 }
    else if (c === '>' && s[L.i + 1] === '>') { parts.push('>>'); L.i += 2 }
    else if (c === '<') parts.push(`(${L.hex().replace(/[\\()]/g, (x) => `\\${x}`)})`)
    else if (c === '/') { const n = L.name(); names.push(n); parts.push(`/${n}`) }
    else if (c === '[' || c === ']' || c === '{' || c === '}') { parts.push(c); L.i++ }
    else if (c === ')' || c === '>') reject('a content stream closes what it never opened')
    else {
      const tok = L.peekToken()
      L.i += tok.length
      parts.push(tok)
      if (tok === 'ID') {
        // Inline image data: one white space, then bytes up to white space, `EI`, and white space or the end.
        const m = /[\0\t\n\f\r ]EI(?=[\0\t\n\f\r ]|$)/.exec(s.slice(L.i + 1))
        if (!m) reject('an inline image never ends')
        L.i = L.i + 1 + m!.index + m![0].length
        parts.push('EI')
      }
    }
  }
  return { text: parts.join(' '), names }
}

interface Stream { num: number; gen: number; dict: Dict; start: number; end: number; objStart: number }

const ACTION_NAMES = new Set(['JavaScript', 'JS', 'Launch', 'SubmitForm', 'GoToR', 'GoToE', 'ImportData'])
const REACHING_NAMES = new Set(['RichMedia', 'XFA', 'EmbeddedFile', 'EmbeddedFiles'])
const TEXT_KEYS = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer'])

export function readPdf(bytes: Uint8Array): FileEvidence | null {
  try {
    return parse(bytes)
  } catch (e) {
    if (e instanceof Reject) return null
    throw e
  }
}

function parse(bytes: Uint8Array): FileEvidence {
  const s = latin1(bytes)
  if (!s.startsWith('%PDF-')) reject('no %PDF- header')
  const L = new Lexer(s)
  const objects = new Map<string, Value>()
  const allObjects: Value[] = []
  const defined = new Set<number>()
  const objStartOf = new Map<number, number>() // offset -> object number, top-level objects only
  const xrefSections = new Set<number>()
  const streams: Stream[] = []
  const trailers: Dict[] = []
  const classic: { num: number; off: number }[] = []
  const startxrefs: number[] = []
  const lengthRefs: { key: string; used: number }[] = []
  const integerAt = (key: string): number | undefined => {
    // An indirect /Length may name an object defined later: found by its own text, then checked once everything is parsed.
    const [n, g] = key.split(' ')
    const m = new RegExp(`(?:^|[\\0\\t\\n\\f\\r ])${n}[\\0\\t\\n\\f\\r ]+${g}[\\0\\t\\n\\f\\r ]+obj[\\0\\t\\n\\f\\r ]+(\\d+)[\\0\\t\\n\\f\\r ]+endobj`).exec(s)
    return m ? Number(m[1]) : undefined
  }
  for (;;) {
    L.skipWs()
    if (L.i >= s.length) break
    const at = L.i
    if (/^\d/.test(s[at]!)) {
      const num = L.int(); L.skipWs()
      const gen = L.int(); L.skipWs()
      if (!L.keyword('obj')) reject(`expected obj at ${L.i}`)
      const v = L.value()
      L.skipWs()
      if (L.keyword('stream')) {
        if (!isDict(v)) reject('a stream without a dictionary')
        const eol = s.startsWith('\r\n', L.i) ? 2 : s[L.i] === '\n' ? 1 : reject('stream is not followed by an end of line')
        const start = L.i + (eol as number)
        const lv = (v as Dict).m.get('Length')
        let length = intOf(lv)
        const r = refOf(lv)
        if (r) {
          length = integerAt(`${r.n} ${r.g}`)
          if (length !== undefined) lengthRefs.push({ key: `${r.n} ${r.g}`, used: length })
        }
        if (length === undefined) reject('a stream has no readable /Length')
        const end = start + length!
        const after = /^(?:\r\n|\r|\n)?endstream(?=[\0\t\n\f\r ]|[()<>[\]{}/%]|$)/.exec(s.slice(end, end + 12))
        if (!after) reject('a stream does not end at endstream where its /Length says')
        streams.push({ num, gen, dict: v as Dict, start, end, objStart: at })
        L.i = end + after![0].length
        L.skipWs()
      }
      if (!L.keyword('endobj')) reject(`expected endobj at ${L.i}`)
      // One definition per object number, incremental updates included (honest generators write none): a viewer finds an object
      // through the xref, this parser by scan order, and two definitions would let them read different objects.
      if (defined.has(num)) reject(`object ${num} is defined more than once`)
      defined.add(num)
      allObjects.push(v)
      objects.set(`${num} ${gen}`, v)
      objStartOf.set(at, num)
    } else if (L.keyword('xref')) {
      xrefSections.add(at)
      for (;;) {
        L.skipWs()
        if (L.peekToken() === 'trailer') break
        const first = L.int(); L.skipWs()
        const count = L.int()
        for (let k = 0; k < count; k++) {
          L.skipWs(); const off = L.int()
          L.skipWs(); L.int()
          L.skipWs()
          const type = L.peekToken()
          if (type !== 'n' && type !== 'f') reject('an xref entry is neither n nor f')
          L.i += 1
          if (type === 'n') classic.push({ num: first + k, off })
        }
      }
    } else if (L.keyword('trailer')) {
      const t = L.value()
      if (!isDict(t)) reject('a trailer is not a dictionary')
      trailers.push(t as Dict)
    } else if (L.keyword('startxref')) {
      L.skipWs()
      startxrefs.push(L.int())
    } else {
      reject(`unexpected bytes at ${at}`)
    }
  }
  for (const { key, used } of lengthRefs) if (objects.get(key) !== used) reject('an indirect /Length is not the integer object it names')

  // Every stream, read by what it is.
  const contents: { text: string; names: string[] }[] = []
  const objStms = new Set<number>()
  const xrefStreamStarts = new Set<number>()
  const inStream: { num: number; container: number }[] = []
  const extraObjects: Value[] = []
  const references: Reference[] = []
  for (const st of streams) {
    const d = st.dict
    const type = nameOf(d.m.get('Type'))
    const subtype = nameOf(d.m.get('Subtype'))
    const fontMarker = d.m.has('Length1') || d.m.has('Length2') || d.m.has('Length3') || (subtype !== undefined && ['Type1C', 'CIDFontType0C', 'OpenType'].includes(subtype))
    const objStmShape = d.m.has('First') && d.m.has('N')
    if (objStmShape && type !== 'ObjStm') reject('a stream shaped as an object stream is not typed as one')
    if (type === 'ObjStm' && (subtype !== undefined || fontMarker)) reject('an object stream carries an image or font marker')
    const pixels = subtype === 'Image' && type !== 'ObjStm'
    const out = decode(d, bytes.subarray(st.start, st.end), pixels)
    if (out === null) reject(`stream ${st.num} can't be decoded in full`)
    if (out === 'pixels' || pixels) continue
    const data = out as Uint8Array
    if (type === 'XRef') {
      xrefStreamStarts.add(st.objStart)
      trailers.push(d)
      const w = d.m.get('W')
      if (!Array.isArray(w) || w.length !== 3 || !w.every((x) => intOf(x) !== undefined && intOf(x)! <= 8)) reject('an xref stream has no readable /W')
      const widths = (w as number[]).map(Number)
      const size = intOf(d.m.get('Size'))
      if (size === undefined) reject('an xref stream has no /Size')
      const idx = d.m.get('Index')
      const ranges: number[] = idx === undefined ? [0, size!] : Array.isArray(idx) && idx.length % 2 === 0 && idx.every((x) => intOf(x) !== undefined) ? (idx as number[]) : reject('an xref stream has an unreadable /Index')
      const rowLen = widths[0]! + widths[1]! + widths[2]!
      const total = ranges.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0)
      if (rowLen === 0 || data.length !== total * rowLen) reject('an xref stream\'s data does not fit its /W and /Index')
      const field = (row: number, k: number) => {
        let v = 0
        const off = row * rowLen + widths.slice(0, k).reduce((a, b) => a + b, 0)
        for (let b = 0; b < widths[k]!; b++) v = v * 256 + data[off + b]!
        return widths[k] === 0 && k === 0 ? 1 : v
      }
      let row = 0
      for (let r = 0; r < ranges.length; r += 2) {
        for (let k = 0; k < ranges[r + 1]!; k++, row++) {
          const t = field(row, 0)
          if (t === 1) classic.push({ num: ranges[r]! + k, off: field(row, 1) })
          else if (t === 2) inStream.push({ num: ranges[r]! + k, container: field(row, 1) })
          else if (t !== 0) reject('an xref stream entry has an unknown type')
        }
      }
    } else if (type === 'ObjStm') {
      objStms.add(st.num)
      const n = intOf(d.m.get('N'))
      const first = intOf(d.m.get('First'))
      if (n === undefined || first === undefined || n > PDF_CAPS.objStmObjects) return reject('an object stream has no readable /N or /First')
      const text = latin1(data)
      const H = new Lexer(text.slice(0, first))
      const offsets: { num: number; off: number }[] = []
      for (let k = 0; k < n!; k++) { H.skipWs(); const num = H.int(); H.skipWs(); offsets.push({ num, off: H.int() }) }
      H.skipWs()
      if (H.i !== first) reject('an object stream\'s header has extra bytes')
      const O = new Lexer(text)
      O.i = first
      for (let k = 0; k < offsets.length; k++) {
        O.skipWs()
        if (O.i !== first + offsets[k]!.off) reject('an object stream\'s object is not where its header says')
        const v = O.value()
        if (defined.has(offsets[k]!.num)) reject(`object ${offsets[k]!.num} is defined more than once`)
        defined.add(offsets[k]!.num)
        objects.set(`${offsets[k]!.num} 0`, v)
        extraObjects.push(v)
      }
      O.skipWs()
      if (O.i !== text.length) reject('an object stream has bytes after its last object')
    } else if (fontMarker || type === 'Metadata' || (type === undefined && subtype === undefined && intOf(d.m.get('N')) !== undefined && !objStmShape)) {
      // A font program, XMP metadata or an ICC profile: data, decoded in full above and not scanned.
    } else {
      contents.push(lexContent(latin1(data)))
    }
  }

  // Every pointer into the file must land on something this parser read.
  for (const e of classic) if (objStartOf.get(e.off) !== e.num) reject(`xref entry for object ${e.num} points at ${e.off}, not at that object`)
  for (const e of inStream) if (!objStms.has(e.container)) reject(`xref entry for object ${e.num} names stream ${e.container}, which is not an object stream`)
  const sections = (off: number) => xrefSections.has(off) || xrefStreamStarts.has(off)
  if (startxrefs.length === 0) reject('no startxref')
  for (const off of startxrefs) if (!sections(off)) reject('startxref points at no xref')
  if (trailers.length === 0) reject('no trailer')
  let root = false
  for (const t of trailers) {
    if (t.m.has('Encrypt')) reject('the file is encrypted')
    const prev = t.m.get('Prev')
    if (prev !== undefined && (intOf(prev) === undefined || !sections(intOf(prev)!))) reject('/Prev points at no xref')
    // A hybrid file's /XRefStm must be an xref stream this parser read, outside any other stream.
    const xs = t.m.get('XRefStm')
    if (xs !== undefined && (intOf(xs) === undefined || !xrefStreamStarts.has(intOf(xs)!))) reject('/XRefStm points at no xref stream')
    for (const key of ['Root', 'Info'] as const) {
      const v = t.m.get(key)
      if (v === undefined) continue
      const r = refOf(v)
      if (!r || !objects.has(`${r.n} ${r.g}`)) reject(`/${key} names no object this parser read`)
      if (key === 'Root') root = true
    }
  }
  if (!root) reject('no /Root')

  // Detection over every object read and every content stream.
  const actions = new Set<string>()
  const textParts: string[] = []
  const resolve = (v: Value | undefined): Value | undefined => {
    const r = refOf(v)
    return r ? objects.get(`${r.n} ${r.g}`) : v
  }
  const noteName = (n: string) => {
    if (ACTION_NAMES.has(n)) actions.add(`/${n}`)
    if (REACHING_NAMES.has(n)) references.push({ kind: 'external', url: `pdf:/${n}` })
  }
  const walk = (v: Value, depth: number): void => {
    if (depth > 200) reject('too deep')
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
    if (typeof v !== 'object' || v === null) return
    if (v.t === 'name') { noteName(v.v); return }
    if (v.t !== 'dict') return
    for (const [k, x] of v.m) {
      noteName(k)
      if (k === 'Encrypt') reject('the file is encrypted')
      if (k === 'URI') {
        const u = strOf(resolve(x))
        if (u !== undefined) references.push({ kind: 'link', url: u })
        else if (!isDict(x)) reject('a /URI is neither a string nor a base URI dictionary')
      }
      if (k === 'S' && refOf(x)) { if (nameOf(resolve(x)) === undefined) reject('an indirect /S is not a name'); noteName(nameOf(resolve(x))!) }
      if ((k === 'OpenAction' || k === 'AA') && refOf(x)) { const t = resolve(x); if (!isDict(t) && !Array.isArray(t)) reject(`an indirect /${k} is neither a dictionary nor an array`) }
      if (TEXT_KEYS.has(k) && strOf(x) !== undefined) textParts.push(strOf(x)!)
      walk(x, depth + 1)
    }
    // A URL file specification, whatever the key order.
    if (nameOf(resolve(v.m.get('FS'))) === 'URL') references.push({ kind: 'external', url: strOf(v.m.get('F')) ?? 'pdf:URL file specification' })
  }
  for (const v of allObjects) walk(v, 0)
  for (const v of extraObjects) walk(v, 0)
  for (const t of trailers) walk(t, 0)
  for (const c of contents) {
    for (const n of c.names) noteName(n)
    const unesc = (x: string) => x.replace(/\\([\\()])/g, '$1')
    for (const m of c.text.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")/g)) textParts.push(unesc(m[1]!))
    for (const m of c.text.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ/g)) textParts.push([...m[1]!.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((x) => unesc(x[1]!)).join(''))
  }
  // Every version of an object is walked, so one link can be listed twice: harmless for the grader.
  return { format: 'pdf', text: textParts.join('\n'), references, actions: [...actions] }
}
