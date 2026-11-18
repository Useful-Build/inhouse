// Where a Library file came from, and how to go there. Shared by the viewer's link and each file's menu.
import type { LibraryFile } from '../../agent'
import { agent } from '../../agent'
import { useUi } from '../../state/store'

export const OPEN: Record<string, string> = { chat: 'Open the chat', routines: 'Open Routines', approval: 'Open the approval' }

/** Goes to where a file came from: its chat, the Routines page or its approval. Uploads have nowhere to go.
 *  A deleted chat can't open, so it says so instead of landing on another chat. Returns whether it went. */
export function openSource(file: LibraryFile): boolean {
  const { openChat, go, openProblem, showToast } = useUi.getState()
  const l = file.link
  if (!l) return false
  if (l.to === 'chat' && agent.getSnapshot().chatDeleted[l.id]) { showToast('That chat was deleted', { icon: 'delete', ms: 4000 }); return false }
  if (l.to === 'chat') openChat(l.id)
  else if (l.to === 'routines') go('routines')
  else openProblem(l.id)
  return true
}
