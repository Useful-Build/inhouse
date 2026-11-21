// Route 41 through the client. Ways it could break, written down before the code:
//  - the request goes to the wrong path (the id unescaped), isn't a GET, or leaves out the sign-in the other calls carry;
//  - the saved name comes from the id or the chip instead of `Content-Disposition`, or a non-ASCII or quoted name is mangled
//    (the `filename*` form must win over the ASCII fallback);
//  - the bytes change on the way (a text decode of a binary file);
//  - a refusal (404 not yours, 401 signed out, a dropped connection) comes back as a file, or as a bare error.
import { describe, expect, test } from 'vitest'
import { AgentError } from '../types'
import { cleanName, downloadFile, nameFromDisposition } from './files'
import { Transport } from './transport'

type Seen = { url: string; method: string; headers: Record<string, string>; credentials: string | undefined }
function setup(answer: () => Response | Promise<Response>, o: { headers?: Record<string, string> } = {}) {
  const seen: Seen[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, credentials: init?.credentials })
    return answer()
  }
  return { seen, http: new Transport({ fetch, origin: 'http://app.test', headers: () => o.headers ?? {} }) }
}
const FILE_ID = 'f_AAAAAAAAAAAAAAAAAAAAAA'
const attachment = (name: string) => `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`

describe('downloadFile (route 41)', () => {
  test('GETs /api/files/<id> with the sign-in headers and the same-origin cookie', async () => {
    const { http, seen } = setup(() => new Response('x', { headers: { 'Content-Disposition': attachment('a.txt') } }), { headers: { 'Cf-Access-Jwt-Assertion': 'tok' } })
    await downloadFile(http, FILE_ID)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ url: `http://app.test/api/files/${FILE_ID}`, method: 'GET', credentials: 'same-origin' })
    expect(seen[0]!.headers['Cf-Access-Jwt-Assertion']).toBe('tok')
  })

  test('escapes an id that is not path-safe', async () => {
    const { http, seen } = setup(() => new Response('x'))
    await downloadFile(http, 'a/b?c')
    expect(seen[0]!.url).toBe('http://app.test/api/files/a%2Fb%3Fc')
  })

  test('takes the name from Content-Disposition, the UTF-8 form first', async () => {
    const { http } = setup(() => new Response('x', { headers: { 'Content-Disposition': attachment('Bestellungen Märż "Q1".csv') } }))
    expect((await downloadFile(http, FILE_ID)).name).toBe('Bestellungen Märż "Q1".csv')
  })

  test('falls back to the quoted ASCII name, and to null when the header has none', async () => {
    const a = setup(() => new Response('x', { headers: { 'Content-Disposition': 'attachment; filename="report.pdf"' } }))
    expect((await downloadFile(a.http, FILE_ID)).name).toBe('report.pdf')
    const b = setup(() => new Response('x'))
    expect((await downloadFile(b.http, FILE_ID)).name).toBeNull()
  })

  test('keeps every byte, binary included', async () => {
    const bytes = new Uint8Array(256).map((_, i) => i)
    const { http } = setup(() => new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }))
    const got = await downloadFile(http, FILE_ID)
    expect(new Uint8Array(await got.blob.arrayBuffer())).toEqual(bytes)
    expect(got.blob.type).toBe('application/octet-stream')
  })

  test.each([[404, 'not_found'], [401, 'unauthorized'], [403, 'forbidden'], [503, 'unavailable']] as const)('a %i answer rejects with %s, not a file', async (status, code) => {
    const { http } = setup(() => new Response(JSON.stringify({ error: { code } }), { status }))
    await expect(downloadFile(http, FILE_ID)).rejects.toMatchObject({ code })
  })

  test('a dropped connection rejects as offline; a login redirect as unauthorized', async () => {
    const down = new Transport({ fetch: async () => { throw new TypeError('x') } })
    await expect(downloadFile(down, FILE_ID)).rejects.toBeInstanceOf(AgentError)
    await expect(downloadFile(down, FILE_ID)).rejects.toMatchObject({ code: 'offline' })
    const redirect = setup(() => Object.defineProperty(new Response(null), 'type', { value: 'opaqueredirect' }))
    await expect(downloadFile(redirect.http, FILE_ID)).rejects.toMatchObject({ code: 'unauthorized' })
  })
})

describe('nameFromDisposition', () => {
  test.each([
    ["attachment; filename=\"a b.txt\"; filename*=UTF-8''a%20b.txt", 'a b.txt'],
    ['attachment; filename="plain.txt"', 'plain.txt'],
    ["attachment; filename*=UTF-8''%E2%82%AC.txt", '€.txt'],
    ['attachment', null],
    ["attachment; filename*=UTF-8''%E0%A4%A", null],
    [null, null],
  ])('%s', (header, want) => { expect(nameFromDisposition(header)).toBe(want) })
})

describe('cleanName', () => {
  test.each([
    ['../x', '_x'],
    ['', null],
    ['a\nb.txt', 'a_b.txt'],
    ['..\\..\\win.ini', '_.._win.ini'],
    ['.hidden', 'hidden'],
    ['   ', null],
    ['x'.repeat(300), 'x'.repeat(200)],
    ['plain.csv', 'plain.csv'],
  ])('%j', (raw, want) => { expect(cleanName(raw)).toBe(want) })

  test('a hostile Content-Disposition name comes out safe', () => {
    expect(nameFromDisposition("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd")).toBe('_.._etc_passwd')
    expect(nameFromDisposition('attachment; filename=""')).toBeNull()
  })
})
