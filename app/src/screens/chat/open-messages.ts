// The messages the open chat shows: its saved history, the agent's turns and the client's own notes, minus what was
// deleted. The thread draws them. The page asks only whether the open chat is a blank new one (`useChatIsBlank`: that is
// the one with the dot grid), which reads three small values and never builds the merged history.
import { useMemo } from 'react'
import type { ChatMessage } from '../../agent/types'
import { chatMessages } from '../../state/derive'
import { openChatKey, useCtx, useUi } from '../../state/store'
import { mergeHistory } from './notes'

export function useOpenChatMessages(): ChatMessage[] {
  const ctx = useCtx()
  const openId = useUi(s => openChatKey(s, ctx.data))
  const history = useUi(s => (openId === null ? undefined : s.history[openId]))
  const extras = useUi(s => s.extras)
  const hidden = useUi(s => s.hidden)
  const all = useMemo(() => mergeHistory(history?.messages, openId === null ? [] : chatMessages(ctx, openId), extras), [ctx, openId, extras, history?.messages])
  return useMemo(() => all.filter(m => !hidden[m.id]), [all, hidden])
}

/**
 * Whether the open chat is a new one with nothing in it yet. A saved chat is never blank, even before its history has loaded
 * (it has messages, they just haven't arrived), so it never flashes the dot grid. A new chat's messages are only the ones
 * added here (`extras`, minus `hidden`).
 */
export function useChatIsBlank(): boolean {
  const ctx = useCtx()
  return useUi(s => openChatKey(s, ctx.data) === null && !s.extras.some(m => !s.hidden[m.id]))
}
