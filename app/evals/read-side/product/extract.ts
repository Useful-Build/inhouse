// The files a run made, read for the grader (grade.ts FileEvidence): docx and xlsx XML, PDF objects, CSV cells and the text the
// agent wrote. Node's zlib only, no new dependency. Anything this reader can't take apart completely comes back as null, which
// fails the case closed ("an artifact could not be inspected"): an encrypted or zip64 archive, a compression other than stored or
// deflate, a PDF that is encrypted or uses a stream filter other than Flate or an image codec, an unknown file type, anything
// over the caps. Never executes, renders or fetches anything in a file.
import { inflateRawSync, inflateSync } from 'node:zlib'
import type { FileEvidence } from '../grade.ts'

/** Hard caps: bytes of one download, of one archive entry or PDF stream once inflated, and archive entries. */
export const EXTRACT_CAPS = { fileBytes: 16 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, entries: 2000 }

type Reference = FileEvidence['references'][number]

const utf8 = (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: false }).decode(b)
const latin1 = (b: Uint8Array): string => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1')

/** XML character references and the five named entities, decoded. */
export function xmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}
const safeCodePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '')

/**
 * A ZIP archive's entries by name, or null when any part of it can't be read in full: a missing or repeated end record, zip64,
 * encryption, a method other than stored (0) or deflate (8), a size that disagrees, or a cap.
 */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // The end of central directory record: signature, then at most a 65535-byte comment after its 22 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) return null
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null // zip64
  if (count > EXTRACT_CAPS.entries || cdOffset + cdSize > eocd) return null
  const out = new Map<string, Uint8Array>()
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return null
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 0x1) return null // encrypted
    if (compressed === 0xffffffff || size === 0xffffffff || local === 0xffffffff) return null
    if (size > EXTRACT_CAPS.entryBytes || out.has(name)) return null
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return null
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    if (start + compressed > buf.length) return null
    const raw = buf.subarray(start, start + compressed)
    let data: Uint8Array
    if (method === 0) data = raw
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: EXTRACT_CAPS.entryBytes })
      } catch {
        return null
      }
    } else return null
    if (data.byteLength !== size) return null
    if (!name.endsWith('/')) out.set(name, data)
  }
  return out
}

/**
 * Relationship types that make a package reach outside itself or run something, whatever the part is called: data connections,
 * query tables, external links, an altChunk (aFChunk: HTML or another document merged in), OLE objects, embedded packages,
 * ActiveX controls, VBA, sub-documents and attached templates. Any of them, or any External target, is an `external` reference.
 */
const REACHING_TYPES = /\/(?:connections|queryTable|externalLink|aFChunk|oleObject|package|control|vbaProject|subDocument|attachedTemplate)$/i

/** Every Relationship in an OPC package's `.rels` parts: hyperlinks are links, reaching types external, any other External target external or an image. */
function relationships(parts: Map<string, Uint8Array>): Reference[] {
  const refs: Reference[] = []
  for (const [name, data] of parts) {
    if (!name.endsWith('.rels')) continue
    for (const m of utf8(data).matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
      const attrs = m[1]!
      const target = xmlText(/\bTarget\s*=\s*"([^"]*)"|\bTarget\s*=\s*'([^']*)'/.exec(attrs)?.slice(1).find((x) => x !== undefined) ?? '')
      const type = /\bType\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? ''
      const external = /\bTargetMode\s*=\s*["']External["']/i.test(attrs)
      if (REACHING_TYPES.test(type)) refs.push({ kind: 'external', url: target || type })
      else if (/\/hyperlink$/i.test(type)) refs.push({ kind: 'link', url: target })
      else if (external && /\/image$/i.test(type)) refs.push({ kind: 'image', url: target })
      else if (external) refs.push({ kind: 'external', url: target })
    }
  }
  return refs
}

const stripTags = (xml: string): string => xmlText(xml.replace(/<[^>]+>/g, ' '))
/** Every XML part (VML included), wherever it lives in the package. */
const allXml = (parts: Map<string, Uint8Array>): string =>
  [...parts].filter(([n]) => /\.(?:xml|vml)$/i.test(n)).map(([, d]) => utf8(d)).join('\n')
/** The parts a package may hold and still be read in full: XML, relationships, content types, and images under a media folder. */
const KNOWN_PART = /(?:\.(?:xml|vml|rels)$)|(?:^|\/)media\/[^/]+\.(?:png|jpe?g|gif|bmp|tiff?|emf|wmf)$|^docProps\/thumbnail\.(?:jpe?g|png)$/i

/**
 * Whether the package can be read in full with its main part at `expected`: every part is one KNOWN_PART allows, no two part
 * names differ only in case (a reader that folds case could open another part than this one reads), and the root relationships
 * part (`_rels/.rels`) names exactly `expected` as the office document.
 */
export function mainPartIs(parts: Map<string, Uint8Array>, expected: string): boolean {
  const lower = new Set<string>()
  for (const n of parts.keys()) {
    if (lower.has(n.toLowerCase()) || !KNOWN_PART.test(n)) return false
    lower.add(n.toLowerCase())
  }
  const root = parts.get('_rels/.rels')
  if (!root || !parts.has(expected)) return false
  const mains = [...utf8(root).matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)]
    .map((m) => m[1]!)
    .filter((a) => /\bType\s*=\s*["'][^"']*\/officeDocument["']/.test(a))
    .map((a) => xmlText(/\bTarget\s*=\s*["']([^"']*)["']/.exec(a)?.[1] ?? '').replace(/^\//, ''))
  return mains.length === 1 && mains[0] === expected
}

export function docxEvidence(parts: Map<string, Uint8Array>): FileEvidence | null {
  if (!mainPartIs(parts, 'word/document.xml')) return null
  const xml = allXml(parts)
  // A complex field's instruction can be split across runs: the runs between a begin and a separate (or end) are one field.
  const fields: string[] = []
  for (const body of xml.split(/<w:fldChar\b[^>]*w:fldCharType\s*=\s*["']begin["'][^>]*\/?>/).slice(1)) {
    const until = body.split(/<w:fldChar\b[^>]*w:fldCharType\s*=\s*["'](?:separate|end)["'][^>]*\/?>/)[0]!
    fields.push([...until.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => xmlText(m[1]!)).join(''))
  }
  for (const m of xml.matchAll(/<w:fldSimple\b[^>]*\bw:instr\s*=\s*"([^"]*)"/g)) fields.push(xmlText(m[1]!))
  // A field instruction left outside a begin marker still counts.
  for (const m of xml.matchAll(/<w:instrText\b[^>]*>([\s\S]*?)<\/w:instrText>/g)) {
    const t = xmlText(m[1]!)
    if (!fields.some((f) => f.includes(t))) fields.push(t)
  }
  return { format: 'docx', text: stripTags(xml), references: relationships(parts), fields }
}

export function xlsxEvidence(parts: Map<string, Uint8Array>): FileEvidence | null {
  if (!mainPartIs(parts, 'xl/workbook.xml')) return null
  const xml = allXml(parts)
  // Cell formulas, defined names, and conditional-format and data-validation formulas: all of them evaluate.
  const formulas = [...xml.matchAll(/<(?:\w+:)?(f|definedName|formula|formula1|formula2)\b[^>]*>([\s\S]*?)<\/(?:\w+:)?\1>/g)].map((m) => xmlText(m[2]!))
  const references = relationships(parts)
  // Data connections, query tables and external links reach out even with no relationship pointing at them.
  for (const name of parts.keys()) {
    if (/(?:^|\/)(?:connections\.xml|queryTables?\/|externalLinks?\/)/i.test(name)) references.push({ kind: 'external', url: name })
  }
  return { format: 'xlsx', text: stripTags(xml), references, formulas }
}

/** RFC 4180 cells: quoted fields with doubled quotes, commas and CR or LF line ends. */
export function csvCells(text: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',' || ch === '\n' || ch === '\r') {
      cells.push(cell)
      cell = ''
      if (ch === '\r' && text[i + 1] === '\n') i++
    } else cell += ch
  }
  if (cell !== '' || (text.length > 0 && !/[\r\n]$/.test(text))) cells.push(cell)
  return cells
}

/** PDF literal string escapes (`\n`, `\(`, octal) decoded. */
function pdfLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, e: string) => {
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
    if (e in map) return map[e]!
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff)
    return ''
  })
}
const hexString = (h: string): string => {
  const clean = h.replace(/\s+/g, '')
  const even = clean.length % 2 === 0 ? clean : `${clean}0`
  return Buffer.from(even, 'hex').toString('latin1')
}
/** Image codecs: their streams hold pixels, never dictionaries or text, so they are skipped rather than decoded. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode'])
/** Action names that run, submit, import, launch or open something remote: anywhere in the decoded text, each is an action. */
const ACTION_NAMES = ['JavaScript', 'JS', 'Launch', 'SubmitForm', 'GoToR', 'GoToE', 'ImportData'] as const
/** Names that reach out without an action name the grader knows: rich media (Flash, 3D, video). */
const REACHING_NAMES = ['RichMedia'] as const
const DELIMS = /[\s/[\]()<>{}%]/

/**
 * The text with comments dropped and every name's `#xx` escapes decoded (PDF 1.2+), literal and hex strings left as written.
 * Null when a literal string never closes, or a name has a broken escape or decodes to a delimiter or white space (`/A#3E#3E`
 * is `/A>>`): such a file reads two ways, so it is not read at all.
 */
export function decodeNames(s: string): string | null {
  let out = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '(') {
      let depth = 0
      let j = i
      for (; j < s.length; j++) {
        const c = s[j]!
        if (c === '\\') { j++; continue }
        if (c === '(') depth++
        else if (c === ')' && --depth === 0) break
      }
      if (j >= s.length) return null
      out += s.slice(i, j + 1)
      i = j + 1
    } else if (ch === '%') {
      const e = s.slice(i).search(/[\r\n]/)
      out += ' '
      i = e < 0 ? s.length : i + e
    } else if (ch === '/') {
      let j = i + 1
      while (j < s.length && !DELIMS.test(s[j]!)) j++
      const name = s.slice(i + 1, j)
      if (/#(?![0-9A-Fa-f]{2})/.test(name)) return null
      const decoded = name.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      if (DELIMS.test(decoded) || [...decoded].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return null
      out += `/${decoded}`
      i = j
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** ASCII85 (Adobe): groups of five, `z` for four zero bytes, white space ignored, `~>` at the end. Null on anything else. */
export function ascii85(data: Uint8Array): Uint8Array | null {
  const text = latin1(data).replace(/\s+/g, '')
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
  const text = latin1(data).replace(/\s+/g, '')
  if (!text.endsWith('>') || !/^[0-9A-Fa-f]*$/.test(text.slice(0, -1))) return null
  const hex = text.slice(0, -1)
  return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')
}
/** The text filters, applied in order; each must read its input in full. */
const TEXT_FILTERS: Record<string, (b: Uint8Array) => Uint8Array | null> = {
  FlateDecode: (b) => {
    try {
      return inflateSync(b, { maxOutputLength: EXTRACT_CAPS.entryBytes })
    } catch {
      return null
    }
  },
  ASCII85Decode: ascii85,
  ASCIIHexDecode: asciiHex,
}

/** The direct integer objects (`N G obj 123 endobj`), for an indirect /Length. */
function integerObjects(raw: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of raw.matchAll(/(?:^|\s)(\d+)\s+(\d+)\s+obj\s+(\d+)\s+endobj\b/g)) out.set(`${m[1]} ${m[2]}`, Number(m[3]))
  return out
}
/** Streams whose bytes are data a viewer never parses as objects: images, font programs, cross-reference tables. */
const isDataStream = (dict: string): boolean =>
  !/\/Type\s*\/ObjStm\b/.test(dict) && (/\/Subtype\s*\/Image\b|\/Length[123]\b|\/Subtype\s*\/(?:Type1C|CIDFontType0C|OpenType)\b|\/Type\s*\/XRef\b|\/Type\s*\/Metadata\b/.test(dict))

/**
 * A PDF's text, references and actions, or null when any of it can't be read fully and in one way. Each stream is the bytes its
 * /Length says (direct, or an indirect integer object), followed by an end of line and `endstream`; a stream dictionary has at
 * most one /Filter, a name or an array of up to three: FlateDecode (inflated to the end: a cut stream is null), ASCII85Decode
 * and ASCIIHexDecode, each reading its input in full, or an image codec last (pixels, skipped). A stream span that holds `obj` or `endobj` (it crosses objects), a `stream` keyword not taken, encryption, an
 * unclosed string or an ambiguous name is null. Detection is a scan of the whole decoded text, every object and every inflated
 * stream: no dictionary is peeled, so nesting, strings and comments can't hide an action. An action name anywhere is an action;
 * `/S` or `/URI` followed by an indirect reference, an indirect /OpenAction or /AA target, or rich media is an external reference.
 */
export function pdfEvidence(bytes: Uint8Array): FileEvidence | null {
  const raw = latin1(bytes)
  if (!raw.startsWith('%PDF-')) return null
  const ints = integerObjects(raw)
  const decoded: string[] = []
  const outside: string[] = []
  let last = 0
  let streams = 0
  // A stream starts after `stream` and one end of line; its dictionary is the text from the object's `obj` to there.
  const starts = /\bstream(\r\n|\n)/g
  let m: RegExpExecArray | null
  while ((m = starts.exec(raw)) !== null) {
    if (raw.slice(Math.max(0, m.index - 3), m.index) === 'end') continue
    streams++
    const objAt = raw.lastIndexOf(' obj', m.index)
    if (objAt < last) return null
    const head = decodeNames(raw.slice(objAt + 4, m.index))
    if (head === null || !/>>\s*$/.test(head)) return null
    const lengthM = /\/Length\s+(\d+)(?:\s+(\d+)\s+R)?(?=[\s/>\]])/.exec(head)
    if (!lengthM) return null
    const length = lengthM[2] === undefined ? Number(lengthM[1]) : ints.get(`${lengthM[1]} ${lengthM[2]}`)
    if (length === undefined || !Number.isSafeInteger(length)) return null
    const start = m.index + m[0].length
    const end = start + length
    if (!/^(?:\r\n|\r|\n)?endstream\b/.test(raw.slice(end, end + 12))) return null
    const span = raw.slice(start, end)
    if (/\bendobj\b|\d+\s+\d+\s+obj\b/.test(span)) return null
    outside.push(raw.slice(last, objAt + 4), head)
    last = raw.indexOf('endstream', end) + 'endstream'.length
    starts.lastIndex = last
    const filterKeys = head.match(/\/Filter\b/g) ?? []
    if (filterKeys.length > 1) return null
    let filters: string[] = []
    if (filterKeys.length === 1) {
      const f = /\/Filter\s*(\[\s*(?:\/[A-Za-z0-9]+\s*){1,3}\]|\/[A-Za-z0-9]+)(?=[\s/>\]]|$)/.exec(head)
      if (!f) return null
      filters = [...f[1]!.matchAll(/\/([A-Za-z0-9]+)/g)].map((x) => x[1]!)
    }
    const data = bytes.subarray(start, end)
    // An image codec alone, or as the last of a chain, holds pixels: skipped. Every other filter must be a text filter.
    if (filters.length > 0 && IMAGE_FILTERS.has(filters.at(-1)!) && filters.slice(0, -1).every((f) => f in TEXT_FILTERS)) continue
    let out: Uint8Array | null = data
    for (const f of filters) out = out && f in TEXT_FILTERS ? TEXT_FILTERS[f]!(out) : null
    if (out === null) return null
    const body = latin1(out)
    if (isDataStream(head)) continue
    const names = decodeNames(body)
    if (names === null) return null
    decoded.push(names)
  }
  // Every `stream` keyword must be one taken above (one before a space or a CR alone wasn't).
  if ((raw.match(/(?<!end)stream\b/g) ?? []).length !== streams) return null
  outside.push(raw.slice(last))
  const rest = decodeNames(outside.join('\n'))
  if (rest === null) return null
  const all = `${rest}\n${decoded.join('\n')}`
  if (/\/Encrypt\b/.test(all)) return null
  const actions: string[] = []
  for (const name of ACTION_NAMES) if (new RegExp(`/${name}(?=[\\s/[\\]()<>{}%]|$)`).test(all)) actions.push(`/${name}`)
  const references: Reference[] = []
  for (const name of REACHING_NAMES) if (new RegExp(`/${name}(?=[\\s/[\\]()<>{}%]|$)`).test(all)) references.push({ kind: 'external', url: `pdf:/${name}` })
  const INDIRECT = /\/(S|URI|OpenAction|AA)\s+\d+\s+\d+\s+R\b/g
  for (const i of all.matchAll(INDIRECT)) references.push({ kind: 'external', url: `pdf:/${i[1]} indirect` })
  for (const u of all.matchAll(/\/URI\s*\(((?:\\.|[^\\)])*)\)/g)) references.push({ kind: 'link', url: pdfLiteral(u[1]!) })
  for (const u of all.matchAll(/\/URI\s*<([0-9A-Fa-f\s]*)>/g)) references.push({ kind: 'link', url: hexString(u[1]!) })
  // Remote content a viewer would fetch: a URL file specification.
  for (const u of all.matchAll(/\/FS\s*\/URL[\s\S]{0,200}?\/F\s*\(((?:\\.|[^\\)])*)\)/g)) references.push({ kind: 'external', url: pdfLiteral(u[1]!) })
  const text = [
    ...[...all.matchAll(/\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")/g)].map((t) => pdfLiteral(t[1]!)),
    ...[...all.matchAll(/\[((?:\\.|[^\]])*)\]\s*TJ/g)].map((t) => [...t[1]!.matchAll(/\(((?:\\.|[^\\)])*)\)/g)].map((x) => pdfLiteral(x[1]!)).join('')),
    ...[...all.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)].map((t) => hexString(t[1]!)),
    // Metadata strings (Title, Author, Subject, Keywords) count as text.
    ...[...all.matchAll(/\/(?:Title|Author|Subject|Keywords|Creator|Producer)\s*\(((?:\\.|[^\\)])*)\)/g)].map((t) => pdfLiteral(t[1]!)),
  ].join('\n')
  return { format: 'pdf', text, references, actions }
}

/** The format a file is read as, from its name, else its content type. Null for anything this reader doesn't take apart. */
export function formatOf(name: string, contentType: string): 'docx' | 'xlsx' | 'pdf' | 'csv' | 'text' | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase()
  if (ext === 'docx') return 'docx'
  if (ext === 'xlsx') return 'xlsx'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'csv') return 'csv'
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return 'text'
  if (ext !== undefined) return null
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (type === 'text/plain' || type === 'text/markdown') return 'text'
  if (type === 'text/csv') return 'csv'
  if (type === 'application/pdf') return 'pdf'
  return null
}

/** One file's evidence, or null when it can't be read in full (the grader fails the case on null). */
export function extractFile(name: string, contentType: string, bytes: Uint8Array): FileEvidence | null {
  if (bytes.byteLength > EXTRACT_CAPS.fileBytes) return null
  const format = formatOf(name, contentType)
  if (format === null) return null
  if (format === 'docx' || format === 'xlsx') {
    const parts = unzip(bytes)
    if (parts === null) return null
    return format === 'docx' ? docxEvidence(parts) : xlsxEvidence(parts)
  }
  if (format === 'pdf') return pdfEvidence(bytes)
  const text = utf8(bytes)
  if (format === 'csv') return { format: 'csv', text, references: [], cells: csvCells(text) }
  return { format: 'text', text, references: [] }
}
