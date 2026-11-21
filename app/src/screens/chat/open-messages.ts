// The messages the open chat shows: its saved history, the agent's turns and the client's own notes, minus what was
// deleted. The thread draws them; the page asks whether there are any (a chat that has started has no dot grid).
import { useMemo } from 'react'
import type { ChatMessage } from '../../agent/types'
import { chatMessages } from '../../state/derive'
import { openChatKey, useCtx, useUi } from '../../state/store'
import { mergeHistory } from './notes'

export function useOpenChatMessages(): ChatMessage[] {
  const ctx = useCtx()
  const { fresh, chatId, extras, hidden } = useUi()
  const openId = openChatKey({ fresh, chatId }, ctx.data)
  const history = useUi(s => (openId === null ? undefined : s.history[openId]))
  const all = useMemo(() => mergeHistory(history?.messages, openId === null ? [] : chatMessages(ctx, openId), extras), [ctx, openId, extras, history?.messages])
  return useMemo(() => all.filter(m => !hidden[m.id]), [all, hidden])
}
