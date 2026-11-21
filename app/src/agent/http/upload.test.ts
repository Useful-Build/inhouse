// Route 39 through the client. Ways it could break, written down before the code:
//  - the file goes to the wrong chat or path (id unescaped), isn't a POST, leaves out the sign-in, or sends the name unencoded
//    (a header carries ASCII only: `X-File-Name` is `encodeURIComponent` of the name);
//  - the bytes are read into memory and re-wrapped (the body must be the File itself, so the browser streams it and sets its length);
//  - the server's refusal reason (`too_large`, `type_not_allowed`, ...) is lost on the way to the person, or an unknown reason
//    is shown raw;
//  - an answer that isn't a chat file passes as one (the id would reach route 29);
//  - a cancel (the controller's abort) goes on to send the file, or rejects like a server fault;
//  - after an upload, the turn carries the file's id from the server, not one the client made up.
import { describe, expect, test } from 'vitest'
import { AgentError } from '../types'
import type { ErrorReason } from '../types'
import { UploadCancelled, uploadFile, uploadRefusalText } from './files'
import { Transport } from './transport'
import { postTurn } from './runs'

const CHAT = 'c_abcdefghijklmnopqrstuv'
const FILE_ID = 'f_0123456789abcdefABCDEF'
const item = (o: Record<string, unknown> = {}) => ({ fileId: FILE_ID, kind: 'input', path: `inputs/${FILE_ID}-a.csv`, name: 'a.csv', bytes: 4, contentType: 'text/csv', atMs: 5, ...o })

type Seen = { url: string; method: string; headers: Record<string, string>; body: unknown; credentials: string | undefined }
function setup(answer: (s: Seen) => Response | Promise<Response>, headers: Record<string, string> = {}) {
  const seen: Seen[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const s: Seen = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body, credentials: init?.credentials }
    seen.push(s)
    return answer(s)
  }
  return { seen, http: new Transport({ fetch, origin: 'http://app.test', headers: () => headers }) }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const csv = (name = 'a.csv') => new File(['a,1\n'], name, { type: 'text/csv' })

describe('uploadFile (route 39)', () => {
  test('POSTs the File itself to /api/chats/<id>/attachments with the sign-in and X-File-Name', async () => {
    const { http, seen } = setup(() => json(201, item()), { 'Cf-Access-Jwt-Assertion': 'tok' })
    const f = csv()
    const got = await uploadFile(http, CHAT, f)
    expect(got.fileId).toBe(FILE_ID)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ url: `http://app.test/api/chats/${CHAT}/attachments`, method: 'POST', credentials: 'same-origin' })
    expect(seen[0]!.body).toBe(f)
    expect(seen[0]!.headers['Cf-Access-Jwt-Assertion']).toBe('tok')
    expect(seen[0]!.headers['X-File-Name']).toBe('a.csv')
  })

  test('encodes the name, whatever it holds, and the chat id in the path', async () => {
    const { http, seen } = setup(() => json(201, item()))
    await uploadFile(http, 'a/b', csv('Bestellungen März "Q1" & 100%.csv'))
    expect(seen[0]!.url).toBe('http://app.test/api/chats/a%2Fb/attachments')
    expect(decodeURIComponent(seen[0]!.headers['X-File-Name']!)).toBe('Bestellungen März "Q1" & 100%.csv')
    expect(seen[0]!.headers['X-File-Name']).toMatch(/^[\x20-\x7e]*$/)
  })

  test.each(['too_large', 'type_not_allowed', 'bad_name', 'length_mismatch', 'length_required', 'hash'])('a 400 invalid %s keeps its reason', async reason => {
    const { http } = setup(() => json(400, { error: { code: 'invalid', reason } }))
    await expect(uploadFile(http, CHAT, csv())).rejects.toMatchObject({ code: 'invalid', reason })
  })

  test('a 404 (not your chat) and a 401 reject by code', async () => {
    await expect(uploadFile(setup(() => json(404, { error: { code: 'not_found' } })).http, CHAT, csv())).rejects.toMatchObject({ code: 'not_found' })
    await expect(uploadFile(setup(() => json(401, { error: { code: 'unauthorized' } })).http, CHAT, csv())).rejects.toMatchObject({ code: 'unauthorized' })
  })

  test('an answer that is not a chat file is refused, not passed on', async () => {
    const { http } = setup(() => json(201, { fileId: 'nope' }))
    await expect(uploadFile(http, CHAT, csv())).rejects.toMatchObject({ code: 'unknown' })
  })

  test('an already-aborted signal sends nothing and rejects as cancelled', async () => {
    const { http, seen } = setup(() => json(201, item()))
    const ctl = new AbortController()
    ctl.abort()
    await expect(uploadFile(http, CHAT, csv(), ctl.signal)).rejects.toBeInstanceOf(UploadCancelled)
    expect(seen).toHaveLength(0)
  })

  test('an abort during the request rejects as cancelled, not offline', async () => {
    const ctl = new AbortController()
    const fetch: typeof globalThis.fetch = (_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      queueMicrotask(() => ctl.abort())
    })
    const http = new Transport({ fetch, origin: 'http://app.test' })
    await expect(uploadFile(http, CHAT, csv(), ctl.signal)).rejects.toBeInstanceOf(UploadCancelled)
  })

  test('the turn that follows carries the id the server gave, not a made-up one', async () => {
    const calls: Seen[] = []
    const { http } = setup(s => {
      calls.push(s)
      return s.url.endsWith('/attachments') ? json(201, item({ fileId: 'f_SERVERSERVERSERVERSERV' })) : json(202, { runId: 'r_aaaaaaaaaaaaaaaaaaaaaa', turnId: 't_aaaaaaaaaaaaaaaaaaaaaa', messageId: 't_aaaaaaaaaaaaaaaaaaaaaa.u', position: 'starting' })
    })
    const k = await http.contract()
    const up = await uploadFile(http, CHAT, csv())
    await postTurn(http, k, CHAT, { clientTurnKey: 'key-0001', text: 'hi', model: 'sonnet', attachments: [{ fileId: up.fileId, name: up.name }] })
    const turn = calls.find(c => !c.url.endsWith('/attachments'))!
    expect(JSON.parse(String(turn.body)).attachments).toEqual([{ fileId: 'f_SERVERSERVERSERVERSERV', name: 'a.csv' }])
  })
})

describe('uploadRefusalText', () => {
  const refused = (reason?: string) => new AgentError('invalid', 'x', reason === undefined ? {} : { reason: reason as ErrorReason })
  test.each([
    ['too_large', 'a.csv is over the 20 MB limit.'],
    ['type_not_allowed', "a.csv isn't a type Inhouse can read. Use a PDF, an image, a spreadsheet, a document or plain text."],
    ['bad_name', "a.csv has a name Inhouse can't keep. Rename it and try again."],
  ])('%s', (reason, text) => { expect(uploadRefusalText('a.csv', refused(reason))).toBe(text) })

  test('anything else, an unknown reason included, is the plain failure', () => {
    for (const e of [refused('length_mismatch'), refused('brand_new_reason'), refused(), new AgentError('unavailable', 'x'), new Error('x')]) {
      expect(uploadRefusalText('a.csv', e)).toBe("Couldn't upload a.csv. Try again.")
    }
  })
})
