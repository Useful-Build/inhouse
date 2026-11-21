// A file in the conversation with its Download button: an attachment a person sent or a file the agent saved. Fetches
// route 41 through the agent client (the sign-in goes with it) and saves what comes back; a refusal is a toast.
import { useState } from 'react'
import { agent } from '../../agent'
import { AgentError } from '../../agent/types'
import { NOT_FOUND } from '../../../shared/contract/error-codes'
import { saveBlob } from '@/lib/save-file'
import { useUi } from '../../state/store'
import { AttachmentChip } from '../../ui'

const downloadFailedText = (name: string, e: unknown) =>
  e instanceof AgentError && e.code === NOT_FOUND ? `${name} isn't there any more.` : `Couldn't download ${name}. Try again.`

export function FileChip({ fileId, icon, name, meta, tap }: { fileId: string; icon: string; name: string; meta: string; tap?: boolean }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const got = await agent.downloadFile(fileId)
      saveBlob(got.name ?? name, got.blob)
    } catch (e) {
      if (!(e instanceof AgentError)) console.error('Inhouse: could not download a file.', e)
      useUi.getState().showToast(downloadFailedText(name, e), { icon: 'error' })
    } finally { setBusy(false) }
  }
  return <AttachmentChip icon={icon} name={name} meta={meta} tap={tap} downloading={busy} onDownload={() => { void run() }} />
}
