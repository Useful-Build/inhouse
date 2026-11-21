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

/**
 * Uploads the pending chips in order. A chip with an id already (a retry) goes as it is. A refusal (`invalid`) drops that
 * file and goes on with the rest. Any other failure, and a cancel, rejects: the message waits to be sent again.
 */
export async function uploadPending(atts: readonly Attachment[], deps: UploadDeps): Promise<Uploaded> {
  const out: Uploaded = { atts: [], refs: [], refused: [] }
  for (const att of atts) {
    if (att.pending === undefined) {
      out.atts.push(att)
      if (att.fileId !== undefined) out.refs.push({ fileId: att.fileId, name: att.name })
      continue
    }
    const file = deps.fileOf(att.pending)
    if (!file) { out.refused.push({ att, text: `${att.name} is no longer attached. Attach it again.` }); continue }
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
