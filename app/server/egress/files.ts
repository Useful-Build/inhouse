// The files route (p3-design 8.5), the chat always the grant's: `GET /files/` lists the chat's current saved files
// (attachments first), `GET /files/<path>` reads one, `PUT /files/<path>` saves one, only under `outputs/`. A PUT takes
// one of the turn's 20 output slots with a conditional insert, streams the body into R2 (files-io/bytes.ts: its
// declared length, 20 MiB at most; the type by magic bytes from its first bytes; the `x-inhouse-sha256` against the
// bytes, before the last of them is written) with that checksum (R2 verifies and keeps it), and leaves the row `pending` until the runner's `file_saved` confirms it. Any refusal after the slot was taken
// frees the slot in the same `finally`. `<path>` arrives with each segment `encodeURIComponent`-encoded.
import { badFileName } from '../../shared/files/names.ts'
import { chatFileKey } from '../db/r2-keys.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import { streamFile } from '../files-io/bytes.ts'
import type { FileRefusal } from '../files-io/bytes.ts'
import { FILE_CAPS } from '../files-io/caps.ts'
import type { EgressDeps } from './deps.ts'
import { jsonAnswer } from './http.ts'

const SHA256 = /^[0-9a-f]{64}$/
const REFUSED_STATUS: Record<FileRefusal, 400 | 413 | 415> = { too_large: 413, length_required: 400, length_mismatch: 400, type_not_allowed: 415, hash: 400 }

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
    const saved = await streamFile(request, name, { max: FILE_CAPS.maxFileBytes, sha256: claimed, put: (body, contentType) => d.files.putBytes(r2Key, body, claimed, contentType) })
    if ('refused' in saved) return jsonAnswer({ error: saved.refused }, REFUSED_STATUS[saved.refused])
    if ('failed' in saved) {
      const e = saved.failed
      d.log({ event: 'egress_file_save_failed', route: 'files', error: e instanceof Error ? e.name : 'unknown' })
      return jsonAnswer({ error: 'save_failed' }, 502)
    }
    // No row changed: the slot is gone, so nothing could confirm these bytes. The object is left to the orphan sweep.
    if (!(await d.files.completeOutput(id, { contentType: saved.contentType, bytes: saved.bytes, sha256: saved.sha256 }))) {
      return jsonAnswer({ error: 'conflict' }, 409)
    }
    kept = true
    return jsonAnswer({ path, bytes: saved.bytes, contentType: saved.contentType }, 201)
  } finally {
    if (!kept) await d.files.dropOutput(id)
  }
}
