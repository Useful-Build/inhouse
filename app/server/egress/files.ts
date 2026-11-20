// The files route (p3-design 8.5), the chat always the grant's: `GET /files/` lists the chat's current saved files
// (attachments first), `GET /files/<path>` reads one, `PUT /files/<path>` saves one, only under `outputs/`. A PUT takes
// one of the turn's 20 output slots with a conditional insert, reads the body with the size counted (20 MiB), checks the
// type by magic bytes and the `x-inhouse-sha256` against the bytes, writes R2 with that checksum (R2 verifies and keeps
// it), and leaves the row `pending` until the runner's `file_saved` confirms it. Any refusal after the slot was taken
// frees the slot in the same `finally`. `<path>` arrives with each segment `encodeURIComponent`-encoded.
import { badFileName } from '../../shared/files/names.ts'
import { chatFileKey } from '../db/r2-keys.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import { checkFile } from '../files-io/bytes.ts'
import { FILE_CAPS } from '../files-io/caps.ts'
import type { EgressDeps } from './deps.ts'
import { jsonAnswer, readCapped } from './http.ts'

const SHA256 = /^[0-9a-f]{64}$/

/** The path below `/files/`, decoded segment by segment; null when it can't be a chat file's name. */
function filePath(rest: string): string | null {
  let path: string
  try {
    path = rest.split('/').map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  return badFileName(path) || path.length > 1024 ? null : path
}

export async function filesRoute(request: Request, urlPath: string, grant: RunGrant, d: EgressDeps): Promise<Response> {
  const chatId = grant.chatId
  if (urlPath === '/files/') {
    if (request.method !== 'GET') return jsonAnswer({ error: 'method' }, 405)
    const files = await d.files.listCurrent(chatId)
    return jsonAnswer({ files: files.map(f => ({ path: f.path, bytes: f.bytes })) })
  }
  const path = filePath(urlPath.slice('/files/'.length))
  if (path === null) return jsonAnswer({ error: 'bad_name' }, 400)

  if (request.method === 'GET') {
    const f = await d.files.currentAt(chatId, path)
    const body = f ? await d.files.readBytes(f) : null
    if (!f || !body) return jsonAnswer({ error: 'not_found' }, 404)
    return new Response(body, { headers: { 'content-type': f.contentType, 'content-length': String(f.bytes) } })
  }
  if (request.method !== 'PUT') return jsonAnswer({ error: 'method' }, 405)
  if (!path.startsWith('outputs/')) return jsonAnswer({ error: 'outputs_only' }, 403)
  const claimed = request.headers.get('x-inhouse-sha256')
  if (claimed === null || !SHA256.test(claimed)) return jsonAnswer({ error: 'hash' }, 400)

  const id = d.newFileId()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const r2Key = chatFileKey(chatId, id)
  if (!(await d.files.reserveOutput({ id, chatId, turnId: grant.turnId, path, name, r2Key, nowMs: d.now() }, FILE_CAPS.maxFilesPerTurn))) {
    return jsonAnswer({ error: 'too_many' }, 409)
  }
  let kept = false
  try {
    const bytes = await readCapped(request, FILE_CAPS.maxFileBytes)
    if (bytes === null) return jsonAnswer({ error: 'too_large' }, 413)
    const checked = await checkFile(bytes, name)
    if ('refused' in checked) return jsonAnswer({ error: 'type_not_allowed' }, 415)
    if (checked.sha256 !== claimed) return jsonAnswer({ error: 'hash' }, 400)
    await d.files.putBytes(r2Key, bytes, checked.sha256, checked.contentType)
    await d.files.completeOutput(id, { contentType: checked.contentType, bytes: bytes.byteLength, sha256: checked.sha256 })
    kept = true
    return jsonAnswer({ path, bytes: bytes.byteLength, contentType: checked.contentType }, 201)
  } finally {
    if (!kept) await d.files.dropOutput(id)
  }
}
