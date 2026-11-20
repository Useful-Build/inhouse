// Saving `outputs/` and restoring the chat's files. Ways it could fail, written first:
// - a name the proxy refuses (`#`) is sent anyway and fails as `save_failed`, or a name it can carry (spaces, unicode)
//   is refused; an encoded name doesn't decode back to the file's own;
// - a file over the size cap is read or sent; the count cap lets one more through; a type is taken from the name, not
//   the bytes; a symlink is followed;
// - an unchanged file (or one just restored) is saved again;
// - a restore writes outside `inputs/` and `outputs/` (`..`, absolute), goes past its size cap, or takes a body longer
//   than its listing said;
// - a failed upload throws out of save instead of becoming a refusal;
// - a symlink the agent planted leads a save to read, or a restore to write, outside `inputs/` and `outputs/`: the
//   folder itself, a folder under it, the restore's temp name, the target (and a symlink there passes the skip check);
// - a hard link to a file elsewhere is saved, or the read isn't checked against what lstat saw;
// - thousands of refusals or left-out names flood the stream or break the schema;
// - HTML or SVG behind a comment, a processing instruction or another tag sniffs as text;
// - a folder under outputs/ that can't be opened (chmod 000) is skipped without a notice;
// - a FIFO swapped in between lstat and the open hangs the read;
// - a Markdown or text file that opens with a tag is taken for HTML;
// - a stop's deadline is checked only between files (not in the walk, nor between a read and its upload), or a restore
//   ignores it, or a cut restore leaves a half-written temp file.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'
import { RunEventBody, type FileCaps } from '../../../shared/protocol/index.ts'
import { LEFT_OUT_MAX, REFUSALS_MAX, capLeftOut, createFiles, filesPath, localPath, snapshotOutputs } from '../../src/files/files.ts'
import { closeDir, openDir, readFileIn } from '../../src/files/safe-dir.ts'
import { sniffType } from '../../src/files/sniff.ts'
import { badProxyPath } from '../../src/proxy/server.ts'
import { PROXY_URL, fakeEgress, type FakeEgress } from '../run/support/fake-egress.ts'

// Runs right after each read of a file being saved, so a test can cut a save between the read and the hash.
const afterRead = vi.hoisted(() => ({ fn: null as (() => void) | null }))
vi.mock('../../src/files/safe-dir.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/files/safe-dir.ts')>()
  return {
    ...real,
    readFileIn: async (...args: Parameters<typeof real.readFileIn>) => {
      const body = await real.readFileIn(...args)
      afterRead.fn?.()
      return body
    },
  }
})

const PDF = Buffer.from('%PDF-1.7\n%test\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const caps = (over: Partial<FileCaps> = {}): FileCaps => ({
  maxFileBytes: 1000,
  maxFilesPerTurn: 10,
  maxRestoreBytes: 1000,
  allowedTypes: ['application/pdf', 'image/png', 'text/csv', 'text/plain'],
  ...over,
})

let cwd: string
/** A folder outside the work folder, as anything else the session's user can read or write. */
let elsewhere: string
let egress: FakeEgress
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'runner-files-'))
  elsewhere = mkdtempSync(join(tmpdir(), 'runner-elsewhere-'))
  egress = fakeEgress()
})
afterEach(() => {
  afterRead.fn = null
  rmSync(cwd, { recursive: true, force: true })
  rmSync(elsewhere, { recursive: true, force: true })
})

function files(c: FileCaps = caps()) {
  const logs: Record<string, unknown>[] = []
  return { f: createFiles({ fetch: egress.fetch, proxyUrl: PROXY_URL, cwd, caps: c, log: (e) => logs.push(e) }), logs }
}

async function saveAll(c: FileCaps = caps(), before = new Map<string, string>()) {
  const events: RunEventBody[] = []
  await files(c).f.save(before, (e) => void events.push(e))
  return events
}

const out = (name: string, body: Uint8Array | string) => {
  const p = join(cwd, 'outputs', name)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body)
}

describe('names through /files/', () => {
  // Segments the proxy can carry: no '#', no '\', not '.' or '..', not empty, no unpaired surrogate.
  const segment = fc.string({ unit: 'binary', minLength: 1, maxLength: 12 }).filter((s) => !s.includes('/') && !s.includes('#') && !s.includes('\\') && s !== '.' && s !== '..' && s.isWellFormed())

  it.prop([fc.array(segment, { minLength: 1, maxLength: 4 })])('a carriable name encodes to a path the proxy takes, which decodes back to the name', (segs) => {
    const p = filesPath(segs.join('/'))
    expect(p).not.toBeNull()
    expect(badProxyPath(p!)).toBe(false)
    expect(p!.slice('/files/'.length).split('/').map(decodeURIComponent)).toEqual(segs)
  })

  it.prop([fc.array(segment, { minLength: 1, maxLength: 3 }), fc.constantFrom('#', 'a#b', '\\', '..', '.', '', '\ud800')])(
    'a name with a segment the proxy cannot carry gets no path',
    (segs, bad) => {
      expect(filesPath([...segs, bad].join('/'))).toBeNull()
    },
  )

  it('saves names with spaces and unicode under their own names; refuses one with # as bad_name', async () => {
    out('quarterly report.pdf', PDF)
    out('résumé ✓ 日本.pdf', PDF)
    out('issue #4.pdf', PDF)
    const events = await saveAll()
    expect(events).toEqual([
      { type: 'file_refused', path: 'outputs/issue #4.pdf', reason: 'bad_name', bytes: PDF.length },
      { type: 'file_saved', path: 'outputs/quarterly report.pdf', bytes: PDF.length, contentType: 'application/pdf' },
      { type: 'file_saved', path: 'outputs/résumé ✓ 日本.pdf', bytes: PDF.length, contentType: 'application/pdf' },
    ])
    expect([...egress.files.keys()].sort()).toEqual(['outputs/quarterly report.pdf', 'outputs/résumé ✓ 日本.pdf'])
    expect(egress.calls.some((c) => c.includes('#'))).toBe(false)
  })
})

describe('saving outputs/', () => {
  it('applies the caps: size per file (never read), count per run, type by magic bytes', async () => {
    out('a.pdf', PDF)
    out('b-really-a-png.pdf', PNG)
    out('c.exe', Buffer.from([0x4d, 0x5a, 0x00, 0x00]))
    out('d.pdf', Buffer.concat([PDF, Buffer.alloc(2000, 0x20)]))
    out('e.csv', 'a,b\n1,2\n')
    out('f.txt', 'hello')
    const events = await saveAll(caps({ maxFilesPerTurn: 2, allowedTypes: ['application/pdf', 'text/csv', 'text/plain'] }))
    expect(events).toEqual([
      { type: 'file_saved', path: 'outputs/a.pdf', bytes: PDF.length, contentType: 'application/pdf' },
      { type: 'file_refused', path: 'outputs/b-really-a-png.pdf', reason: 'type_not_allowed', bytes: PNG.length },
      { type: 'file_refused', path: 'outputs/c.exe', reason: 'type_not_allowed', bytes: 4 },
      { type: 'file_refused', path: 'outputs/d.pdf', reason: 'too_large', bytes: PDF.length + 2000 },
      { type: 'file_saved', path: 'outputs/e.csv', bytes: 8, contentType: 'text/csv' },
      { type: 'file_refused', path: 'outputs/f.txt', reason: 'too_many', bytes: 5 },
    ])
    expect(egress.files.get('outputs/e.csv')?.contentType).toBe('text/csv')
  })

  it('saves only new or changed files, in subfolders too; never follows a symlink', async () => {
    out('old.pdf', PDF)
    out('same.pdf', PDF)
    const before = await snapshotOutputs(cwd)
    out('old.pdf', Buffer.concat([PDF, Buffer.from('more')]))
    out('deep/er/new.pdf', PDF)
    symlinkSync('/etc/hosts', join(cwd, 'outputs', 'link.pdf'))
    const events = await saveAll(caps(), before)
    expect(events).toEqual([
      { type: 'file_refused', path: 'outputs/link.pdf', reason: 'type_not_allowed' },
      { type: 'file_saved', path: 'outputs/deep/er/new.pdf', bytes: PDF.length, contentType: 'application/pdf' },
      { type: 'file_saved', path: 'outputs/old.pdf', bytes: PDF.length + 4, contentType: 'application/pdf' },
    ])
  })

  it('a failed upload is a save_failed refusal, never a throw', async () => {
    out('a.pdf', PDF)
    egress.fail = (m) => (m === 'PUT' ? 500 : null)
    expect(await saveAll()).toEqual([{ type: 'file_refused', path: 'outputs/a.pdf', reason: 'save_failed', bytes: PDF.length }])
  })
})

describe('symlinks and links the agent planted (saving)', () => {
  it('a symlinked outputs/ saves nothing from where it points', async () => {
    writeFileSync(join(elsewhere, 'secret.pdf'), PDF)
    symlinkSync(elsewhere, join(cwd, 'outputs'))
    const { f, logs } = files()
    const events: RunEventBody[] = []
    expect(await f.save(new Map(), (e) => void events.push(e))).toBe(true)
    expect(events).toEqual([])
    expect(egress.calls.filter((c) => c.startsWith('PUT'))).toEqual([])
    expect(logs).toContainEqual(expect.objectContaining({ type: 'outputs_not_a_folder' }))
    expect(await snapshotOutputs(cwd)).toEqual(new Map())
  })

  it('a symlinked folder under outputs/ is refused, never walked', async () => {
    writeFileSync(join(elsewhere, 'secret.pdf'), PDF)
    out('real.pdf', PDF)
    symlinkSync(elsewhere, join(cwd, 'outputs', 'sub'))
    const events = await saveAll()
    expect(events).toEqual([
      { type: 'file_refused', path: 'outputs/sub', reason: 'type_not_allowed' },
      { type: 'file_saved', path: 'outputs/real.pdf', bytes: PDF.length, contentType: 'application/pdf' },
    ])
    expect(egress.files.has('outputs/sub/secret.pdf')).toBe(false)
  })

  it('a folder under outputs/ swapped for a symlink after the walk is refused, not followed', async () => {
    out('a.pdf', PDF)
    out('sub/secret.pdf', PDF)
    writeFileSync(join(elsewhere, 'secret.pdf'), Buffer.concat([PDF, Buffer.from('elsewhere')]))
    const events: RunEventBody[] = []
    // The files are saved in order: while a.pdf's event is out, the agent swaps sub/ for a symlink to elsewhere.
    await files().f.save(new Map(), (e) => {
      events.push(e)
      if (e.type === 'file_saved' && e.path === 'outputs/a.pdf') {
        renameSync(join(cwd, 'outputs', 'sub'), join(cwd, 'outputs', 'sub-moved'))
        symlinkSync(elsewhere, join(cwd, 'outputs', 'sub'))
      }
    })
    expect(events).toEqual([
      { type: 'file_saved', path: 'outputs/a.pdf', bytes: PDF.length, contentType: 'application/pdf' },
      { type: 'file_refused', path: 'outputs/sub/secret.pdf', reason: 'save_failed' },
    ])
    expect(egress.files.has('outputs/sub/secret.pdf')).toBe(false)
  })

  it('a hard link to a file elsewhere is refused', async () => {
    writeFileSync(join(elsewhere, 'secret.pdf'), PDF)
    mkdirSync(join(cwd, 'outputs'))
    linkSync(join(elsewhere, 'secret.pdf'), join(cwd, 'outputs', 'linked.pdf'))
    expect(await saveAll()).toEqual([{ type: 'file_refused', path: 'outputs/linked.pdf', reason: 'type_not_allowed', bytes: PDF.length }])
    expect(egress.files.size).toBe(0)
  })

  it('the read is refused when the open file is not the one lstat saw', async () => {
    out('a.pdf', PDF)
    out('b.pdf', PDF)
    const dir = await openDir(join(cwd, 'outputs'))
    try {
      await expect(readFileIn(dir, 'a.pdf', lstatSync(join(cwd, 'outputs', 'b.pdf')))).rejects.toThrow(/not the file/)
      expect(Buffer.from(await readFileIn(dir, 'a.pdf', lstatSync(join(cwd, 'outputs', 'a.pdf'))))).toEqual(PDF)
    } finally {
      await closeDir(dir)
    }
  })

  // As root the chmod doesn't stop the open.
  ;(process.getuid?.() === 0 ? it.skip : it)('a folder under outputs/ that cannot be opened is refused with a notice', async () => {
    out('a.pdf', PDF)
    out('locked/b.pdf', PDF)
    chmodSync(join(cwd, 'outputs', 'locked'), 0o000)
    try {
      expect(await saveAll()).toEqual([
        { type: 'file_refused', path: 'outputs/locked', reason: 'save_failed' },
        { type: 'file_saved', path: 'outputs/a.pdf', bytes: PDF.length, contentType: 'application/pdf' },
      ])
    } finally {
      chmodSync(join(cwd, 'outputs', 'locked'), 0o755)
    }
  })

  it('a FIFO swapped in between lstat and the open is refused at once, never waited on', async () => {
    out('a.pdf', PDF)
    const seen = lstatSync(join(cwd, 'outputs', 'a.pdf'))
    rmSync(join(cwd, 'outputs', 'a.pdf'))
    execFileSync('mkfifo', [join(cwd, 'outputs', 'a.pdf')])
    const dir = await openDir(join(cwd, 'outputs'))
    try {
      await expect(readFileIn(dir, 'a.pdf', seen)).rejects.toThrow(/not the file/)
    } finally {
      await closeDir(dir)
    }
  })

  it(`past ${REFUSALS_MAX} refusals, the rest are counted in one file_refused_more`, async () => {
    for (let i = 0; i < REFUSALS_MAX + 10; i++) out(`x-${String(i).padStart(3, '0')}.exe`, Buffer.from([0x4d, 0x5a, 0, 0]))
    const events = await saveAll()
    expect(events).toHaveLength(REFUSALS_MAX + 1)
    expect(events.at(-1)).toEqual({ type: 'file_refused_more', count: 10 })
    for (const e of events) expect(RunEventBody.safeParse(e).success).toBe(true)
  })
})

describe("a stop's deadline", () => {
  it('cuts a save inside the walk, and between a read and its upload; a later save sends what it did not', async () => {
    out('a.pdf', PDF)
    symlinkSync(elsewhere, join(cwd, 'outputs', 'link'))
    const { f } = files()
    const events: RunEventBody[] = []
    const emit = (e: RunEventBody) => void events.push(e)
    // Cut before the walk: nothing is looked at, nothing said.
    expect(await f.save(new Map(), emit, AbortSignal.abort())).toBe(false)
    expect(events).toEqual([])
    // Cut once a.pdf has been read: it's never sent.
    const mid = new AbortController()
    afterRead.fn = () => mid.abort()
    expect(await f.save(new Map(), emit, mid.signal)).toBe(false)
    afterRead.fn = null
    expect(egress.calls.filter((c) => c.startsWith('PUT'))).toEqual([])
    expect(await f.save(new Map(), emit)).toBe(true)
    expect(events).toEqual([
      { type: 'file_refused', path: 'outputs/link', reason: 'type_not_allowed' },
      { type: 'file_saved', path: 'outputs/a.pdf', bytes: PDF.length, contentType: 'application/pdf' },
    ])
  })

  it('cuts a restore mid-write, and leaves no temp file behind', async () => {
    const big = new Uint8Array(8 * 1024 * 1024).fill(0x61)
    egress.files.set('inputs/big.txt', { body: big })
    const cut = new AbortController()
    const real = egress.fetch
    egress.fetch = async (url, init) => {
      const res = await real(url, init)
      if (!url.endsWith('/files/inputs/big.txt')) return res
      const body = await res.arrayBuffer()
      // The cut lands on the next turn of the event loop, once the write has begun.
      return { ok: true, status: 200, arrayBuffer: async () => (setImmediate(() => cut.abort()), body) } as unknown as Response
    }
    await expect(files(caps({ maxRestoreBytes: big.length })).f.restore(cut.signal)).rejects.toThrow()
    expect(readdirSync(join(cwd, 'inputs'))).toEqual([])
  })
})

describe('restoring the chat files', () => {
  it('brings in what is missing, in listing order, up to the cap; names the rest; skips what is already here', async () => {
    egress.files.set('inputs/brief one.pdf', { body: new Uint8Array(PDF) })
    egress.files.set('outputs/table.csv', { body: new TextEncoder().encode('a,b\n') })
    egress.files.set('outputs/big.pdf', { body: new Uint8Array(900) })
    egress.files.set('inputs/later.pdf', { body: new Uint8Array(PDF) })
    const r = await files(caps({ maxRestoreBytes: PDF.length * 2 + 4 })).f.restore()
    expect(r.leftOut).toEqual(['outputs/big.pdf'])
    expect(r.event).toEqual({ type: 'files_restored', restored: 3, bytes: PDF.length * 2 + 4, leftOut: ['outputs/big.pdf'] })
    expect(readFileSync(join(cwd, 'inputs', 'brief one.pdf'))).toEqual(PDF)
    // A second restore: everything here already, nothing downloaded again.
    const gets = () => egress.calls.filter((c) => c.startsWith('GET /files/') && c !== 'GET /files/').length
    const before = gets()
    expect((await files(caps({ maxRestoreBytes: PDF.length * 2 + 4 })).f.restore()).event).toMatchObject({ restored: 0 })
    expect(gets()).toBe(before)
  })

  it('a restored file is not saved again at the run end', async () => {
    egress.files.set('outputs/x.pdf', { body: new Uint8Array(PDF) })
    await files().f.restore()
    expect(await saveAll(caps(), await snapshotOutputs(cwd))).toEqual([])
  })

  it.each(['../escape.pdf', 'outputs/../../escape.pdf', '/etc/passwd', 'other/x.pdf', 'inputs/a\\b.pdf', 'inputs'])('never writes a listed path outside inputs/ and outputs/: %s', async (bad) => {
    egress.files.set(bad, { body: new Uint8Array(PDF) })
    const { f, logs } = files()
    expect((await f.restore()).event).toMatchObject({ restored: 0 })
    expect(logs).toContainEqual(expect.objectContaining({ type: 'file_restore_skipped' }))
    expect(localPath(cwd, bad)).toBeNull()
  })

  it('a symlinked inputs/ fails the restore; nothing is written where it points', async () => {
    symlinkSync(elsewhere, join(cwd, 'inputs'))
    egress.files.set('inputs/a.pdf', { body: new Uint8Array(PDF) })
    await expect(files().f.restore()).rejects.toThrow(/not followed/)
    expect(existsSync(join(elsewhere, 'a.pdf'))).toBe(false)
  })

  it('a symlinked folder under inputs/ is skipped; nothing is written where it points', async () => {
    mkdirSync(join(cwd, 'inputs'))
    symlinkSync(elsewhere, join(cwd, 'inputs', 'sub'))
    egress.files.set('inputs/sub/a.pdf', { body: new Uint8Array(PDF) })
    const { f, logs } = files()
    expect((await f.restore()).event).toMatchObject({ restored: 0 })
    expect(existsSync(join(elsewhere, 'a.pdf'))).toBe(false)
    expect(logs).toContainEqual(expect.objectContaining({ type: 'file_restore_skipped', reason: 'symlink on the way' }))
  })

  it('a symlink planted at the old temp name or at the target is never written through', async () => {
    mkdirSync(join(cwd, 'outputs'))
    writeFileSync(join(elsewhere, 'victim'), 'untouched')
    // The temp name the restore used to use, and the target itself, both pointing elsewhere; the target's link points
    // at a file of the listed size, which a following stat would take as "already here".
    symlinkSync(join(elsewhere, 'victim'), join(cwd, 'outputs', 'a.pdf.restoring'))
    writeFileSync(join(elsewhere, 'same-size'), Buffer.alloc(PDF.length))
    symlinkSync(join(elsewhere, 'same-size'), join(cwd, 'outputs', 'a.pdf'))
    egress.files.set('outputs/a.pdf', { body: new Uint8Array(PDF) })
    expect((await files().f.restore()).event).toMatchObject({ restored: 1 })
    expect(readFileSync(join(elsewhere, 'victim'), 'utf8')).toBe('untouched')
    expect(readFileSync(join(elsewhere, 'same-size'))).toEqual(Buffer.alloc(PDF.length))
    expect(lstatSync(join(cwd, 'outputs', 'a.pdf')).isFile()).toBe(true)
    expect(readFileSync(join(cwd, 'outputs', 'a.pdf'))).toEqual(PDF)
    expect(readlinkSync(join(cwd, 'outputs', 'a.pdf.restoring'))).toBe(join(elsewhere, 'victim'))
    expect(statSync(join(elsewhere, 'victim')).size).toBe('untouched'.length)
  })

  it(`left-out names are capped at ${LEFT_OUT_MAX}, the last saying how many more`, () => {
    const names = Array.from({ length: 1200 }, (_, i) => `inputs/f-${i}.pdf`)
    const capped = capLeftOut(names)
    expect(capped).toHaveLength(LEFT_OUT_MAX)
    expect(capped.at(-1)).toBe('and 201 more')
    expect(RunEventBody.safeParse({ type: 'files_restored', restored: 0, bytes: 0, leftOut: capped }).success).toBe(true)
    expect(capLeftOut(names.slice(0, 3))).toEqual(names.slice(0, 3))
  })

  it('a body longer than its listing fails the restore', async () => {
    egress.files.set('inputs/a.pdf', { body: new Uint8Array(PDF) })
    const real = egress.fetch
    egress.fetch = async (url, init) => {
      const res = await real(url, init)
      if (url.endsWith('/files/')) return Response.json({ files: [{ path: 'inputs/a.pdf', bytes: 3 }] })
      return res
    }
    await expect(files().f.restore()).rejects.toThrow(/listed as 3/)
  })
})

describe('sniffType', () => {
  it('reads types from bytes', () => {
    expect(sniffType(PDF, 'x.png')).toBe('application/pdf')
    expect(sniffType(PNG, 'x.pdf')).toBe('image/png')
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'page.html')).toBe('image/svg+xml')
    expect(sniffType(Buffer.from('<!DOCTYPE html><p>'), 'page.html')).toBe('text/html')
    expect(sniffType(Buffer.from('{"a":1}'), 'x.json')).toBe('application/json')
    expect(sniffType(Buffer.from([0xff, 0xfe, 0x00]), 'x.txt')).toBe('application/octet-stream')
  })

  it('a .md or .txt file that opens with a tag stays text (served with nosniff and the sandbox CSP)', () => {
    expect(sniffType(Buffer.from('<div align="center">\n\n# Title\n'), 'README.md')).toBe('text/markdown')
    expect(sniffType(Buffer.from('<p>notes</p>'), 'notes.txt')).toBe('text/plain')
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'X.TXT')).toBe('text/plain')
    expect(sniffType(Buffer.from('<p>notes</p>'), 'notes.html')).toBe('text/html')
    expect(sniffType(Buffer.from([0xff, 0xfe, 0x00]), 'x.md')).toBe('application/octet-stream')
  })

  it.each([
    ['<!-- a note --><html><body>x</body></html>', 'text/html'],
    ['<script>alert(1)</script>', 'text/html'],
    ['  \n<body onload="x()">', 'text/html'],
    ['\ufeff<!DOCTYPE html>', 'text/html'],
    ['<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x"><svg/>', 'image/svg+xml'],
    ['<!-- one --> <!-- two --><svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml'],
    ['<!-- never closed <svg', 'text/html'],
    ['<p>', 'text/html'],
    ['<pre>not a marker</pre>', 'text/plain'],
    ['a < b and <b> later', 'text/plain'],
  ])('sniffs markup behind comments, instructions and other tags: %s', (text, type) => {
    expect(sniffType(Buffer.from(text), 'page.html')).toBe(type)
  })

  it('tells an xlsx from a plain zip by its parts', () => {
    const entry = (name: string) => {
      const n = Buffer.from(name)
      const h = Buffer.alloc(30)
      h.writeUInt32LE(0x04034b50, 0)
      h.writeUInt16LE(n.length, 26)
      return Buffer.concat([h, n])
    }
    expect(sniffType(Buffer.concat([entry('[Content_Types].xml'), entry('xl/workbook.xml')]), 'a.zip')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(sniffType(Buffer.concat([entry('xl/workbook.xml')]), 'a.xlsx')).toBe('application/zip')
  })

  it.prop([fc.uint8Array({ maxLength: 64 }), fc.string()])('never throws', (bytes, name) => {
    expect(typeof sniffType(bytes, name)).toBe('string')
  })
})
