// A message's files, from the composer's chips to the ids route 29 takes. The chips of a real client hold a file until
// the send (`pending`); the send uploads each one (route 39) and names the id the server gave. Plain code: the store
// passes in the agent's upload, so a test passes a stand-in.
import { uploadRefusalText } from '../../agent/http/files'
import { UploadCancelled } from '../../agent/http/transport'
import { AgentError } from '../../agent/types'
import type { Attachment, AttachmentRef } from '../../agent/types'

export interface UploadDeps {
  /** The file a chip holds, or undefined when it is gone (the page reloaded). */
  fileOf(pending: string): File | undefined
  upload(file: File, signal: AbortSignal): Promise<{ fileId: string; name: string }>
  signal: AbortSignal
  /** Each file as it lands, so a send that fails later doesn't upload it again on retry. */
  onUploaded?(att: Attachment, ref: AttachmentRef): void
}

export interface Uploaded {
  /** The chips that go: each with the server's id, none still pending. */
  atts: Attachment[]
  refs: AttachmentRef[]
  /** The files the server refused (or that are gone), each with words for the person. They don't go. */
  refused: { att: Attachment; text: string }[]
}

const GONE = (name: string) => `${name} is no longer attached. Attach it again.`

/**
 * Uploads the pending chips in order. A chip with an id already (a retry) goes as it is. A refusal (`invalid`) drops that
 * file and goes on with the rest. Any other failure, and a cancel, rejects: the message waits to be sent again. A chip with
 * neither an id nor a held file (saved before a reload) is refused, never sent without its file.
 */
export async function uploadPending(atts: readonly Attachment[], deps: UploadDeps): Promise<Uploaded> {
  const out: Uploaded = { atts: [], refs: [], refused: [] }
  for (const att of atts) {
    if (att.pending === undefined && att.fileId !== undefined) {
      out.atts.push(att)
      out.refs.push({ fileId: att.fileId, name: att.name })
      continue
    }
    const file = att.pending === undefined ? undefined : deps.fileOf(att.pending)
    if (!file) { out.refused.push({ att, text: GONE(att.name) }); continue }
    try {
      const kept = await deps.upload(file, deps.signal)
      const { pending: _, ...rest } = att
      const ref = { fileId: kept.fileId, name: kept.name }
      out.atts.push({ ...rest, fileId: kept.fileId })
      out.refs.push(ref)
      deps.onUploaded?.(att, ref)
    } catch (e) {
      if (e instanceof UploadCancelled || !(e instanceof AgentError) || e.code !== 'invalid') throw e
      out.refused.push({ att, text: uploadRefusalText(att.name, e) })
    }
  }
  return out
}

/** How one send's files came out. `atts` is always the chips a retry starts from: landed ones carry their ids, refused ones are gone, the rest are still pending. */
export type Attempt =
  | { kind: 'ready'; atts: Attachment[]; refs: AttachmentRef[] }
  | { kind: 'refused'; atts: Attachment[]; text: string }
  | { kind: 'cancelled'; atts: Attachment[] }
  | { kind: 'failed'; atts: Attachment[]; error: unknown }

/**
 * `uploadPending` as the send uses it: never throws, and says which files are on the server whatever happened. `release` is
 * called with each chip's key once its file needn't be held any more (it landed, or it was refused or gone).
 */
export async function attemptUpload(atts: readonly Attachment[], deps: UploadDeps, release: (pending: string) => void): Promise<Attempt> {
  const landed = new Map<string, string>()
  const settle = (list: readonly Attachment[]): Attachment[] => list.flatMap(a => {
    if (a.pending === undefined || !landed.has(a.pending)) return [a]
    release(a.pending)
    const { pending: _, ...rest } = a
    return [{ ...rest, fileId: landed.get(a.pending)! }]
  })
  try {
    const up = await uploadPending(atts, { ...deps, onUploaded: (a, ref) => { landed.set(a.pending!, ref.fileId); deps.onUploaded?.(a, ref) } })
    for (const a of atts) if (a.pending !== undefined) release(a.pending)
    return up.refused.length ? { kind: 'refused', atts: up.atts, text: up.refused.map(r => r.text).join(' ') } : { kind: 'ready', atts: up.atts, refs: up.refs }
  } catch (error) {
    const left = settle(atts)
    return error instanceof UploadCancelled ? { kind: 'cancelled', atts: left } : { kind: 'failed', atts: left, error }
  }
}

/** What Stop during an upload ends the send with: the text and chips stay in the chat for Try again. */
export const UPLOAD_STOPPED = 'Stopped before it was sent. Try again to send it.'
export class UploadStopped extends Error {
  constructor() { super(UPLOAD_STOPPED); this.name = 'UploadStopped' }
}

/** The uploads of the sends into one run. Stop ends all of them; a send that finishes lets go of only its own. */
export class AbortSet {
  private readonly all = new Set<AbortController>()
  add(): AbortController { const c = new AbortController(); this.all.add(c); return c }
  remove(c: AbortController): void { this.all.delete(c) }
  abortAll(): void { for (const c of this.all) c.abort() }
  get size(): number { return this.all.size }
}
