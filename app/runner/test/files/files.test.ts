// Saving `outputs/` and restoring the chat's files. Ways it could fail, written first:
// - a name the proxy refuses (`#`) is sent anyway and fails as `save_failed`, or a name it can carry (spaces, unicode)
//   is refused; an encoded name doesn't decode back to the file's own;
// - a file over the size cap is read or sent; the count cap lets one more through; a type is taken from the name, not
//   the bytes; a symlink is followed;
// - an unchanged file (or one just restored) is saved again;
// - a restore writes outside `inputs/` and `outputs/` (`..`, absolute), goes past its size cap, or takes a body longer
//   than its listing said;
// - a failed upload throws out of save instead of becoming a refusal.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect } from 'vitest'
import type { FileCaps, RunEventBody } from '../../../shared/protocol/index.ts'
import { createFiles, filesPath, localPath, snapshotOutputs } from '../../src/files/files.ts'
import { sniffType } from '../../src/files/sniff.ts'
import { badProxyPath } from '../../src/proxy/server.ts'
import { PROXY_URL, fakeEgress, type FakeEgress } from '../run/support/fake-egress.ts'

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
let egress: FakeEgress
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'runner-files-'))
  egress = fakeEgress()
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

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

describe('restoring the chat files', () => {
  it('brings in what is missing, in listing order, up to the cap; names the rest; skips what is already here', async () => {
    egress.files.set('inputs/brief one.pdf', { body: new Uint8Array(PDF) })
    egress.files.set('outputs/table.csv', { body: new TextEncoder().encode('a,b\n') })
    egress.files.set('outputs/big.pdf', { body: new Uint8Array(900) })
    egress.files.set('inputs/later.pdf', { body: new Uint8Array(PDF) })
    const r = await files(caps({ maxRestoreBytes: PDF.length * 2 + 4 })).f.restore()
    expect(r).toEqual({ type: 'files_restored', restored: 3, bytes: PDF.length * 2 + 4, leftOut: ['outputs/big.pdf'] })
    expect(readFileSync(join(cwd, 'inputs', 'brief one.pdf'))).toEqual(PDF)
    // A second restore: everything here already, nothing downloaded again.
    const gets = () => egress.calls.filter((c) => c.startsWith('GET /files/') && c !== 'GET /files/').length
    const before = gets()
    expect(await files(caps({ maxRestoreBytes: PDF.length * 2 + 4 })).f.restore()).toMatchObject({ restored: 0 })
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
    expect(await f.restore()).toMatchObject({ restored: 0 })
    expect(logs).toContainEqual(expect.objectContaining({ type: 'file_restore_skipped' }))
    expect(localPath(cwd, bad)).toBeNull()
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
    expect(sniffType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.txt')).toBe('image/svg+xml')
    expect(sniffType(Buffer.from('<!DOCTYPE html><p>'), 'x.txt')).toBe('text/html')
    expect(sniffType(Buffer.from('{"a":1}'), 'x.json')).toBe('application/json')
    expect(sniffType(Buffer.from([0xff, 0xfe, 0x00]), 'x.txt')).toBe('application/octet-stream')
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
