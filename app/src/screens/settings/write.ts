// What a Settings write says when it was refused as stale (C6, S6). The agent already took the change back and holds the
// record as it is now, so the page shows that value: "Someone changed this. It's now X."
import { AgentError } from '../../agent/types'
import { useUi } from '../../state/store'
import { nowIs } from './now-is'
import type { Words } from './now-is'

/** Tells the person about a stale save. Any other failure was already told by the agent's own notice. */
export function tell(write: Promise<unknown>, words?: Words): void {
  write.catch((e: unknown) => {
    if (!(e instanceof AgentError) || e.code !== 'conflict' || !e.current) return
    const now = nowIs(e.current, words)
    // Same key as the agent's own "Someone changed this" notice, so this replaces it.
    useUi.getState().showToast(now ? `Someone changed this. It's now ${now}.` : 'Someone changed this. It has been updated.', { icon: 'info', key: 'conflict' })
  })
}
