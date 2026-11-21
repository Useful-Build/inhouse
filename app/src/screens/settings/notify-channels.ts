// The Slack notices page's state (P5 W4): the channel list (route 73) while the page is open, the picker's channels for an
// Admin or the Inhouse team (route 74, every page), and the saves (route 75), each the whole list with the rev it was
// read at. A refusal says why in a toast and the list shows as it is now.
import { useEffect, useState } from 'react'
import { agent } from '../../agent'
import { AgentError } from '../../agent/types'
import { REASON } from '../../../shared/contract/error-codes'
import type { AvailableChannel, NotifyChannelList } from '../../agent/types'
import { useUi } from '../../state/store'
import type { NotifyView } from './content'

/** What a refused save says, by reason; anything else is the generic line. */
export const SAVE_REFUSED: Readonly<Record<string, string>> = {
  shared_channel: "That channel is shared with another company, so it can't be listed.",
  archived: "That channel is archived, so it can't be listed.",
  not_public: 'Only public channels can be listed.',
  not_member: "The connected Slack account isn't in that channel. Add it in Slack first.",
  not_found: "That channel isn't in Slack any more.",
  name_taken: "Two listed channels can't share a name.",
}

/** The most picker pages read (200 channels each). */
const MAX_PAGES = 10

export function useNotifyChannels(active: boolean, canEdit: boolean): NotifyView {
  // `reads` counts the reads asked for (Try again adds one); a result belongs to the read it answered.
  const [reads, setReads] = useState(0)
  const [result, setResult] = useState<{ read: number; ok: boolean } | null>(null)
  const [list, setList] = useState<NotifyChannelList | null>(null)
  const [available, setAvailable] = useState<AvailableChannel[] | null>(null)
  const [pickerError, setPickerError] = useState<NotifyView['pickerError']>(null)
  const [busy, setBusy] = useState(false)
  const toast = (text: string) => useUi.getState().showToast(text, { icon: 'info', key: 'notify-channels' })

  useEffect(() => {
    if (!active) return
    let live = true
    agent.listNotifyChannels().then(l => { if (live) { setList(l); setResult({ read: reads, ok: true }) } }, () => { if (live) setResult({ read: reads, ok: false }) })
    if (canEdit) {
      void (async () => {
        const all: AvailableChannel[] = []
        let cursor: string | undefined
        try {
          for (let i = 0; i < MAX_PAGES; i++) {
            const page = await agent.availableNotifyChannels(cursor)
            all.push(...page.channels)
            if (!page.nextCursor) break
            cursor = page.nextCursor
          }
          if (live) { setAvailable(all); setPickerError(null) }
        } catch (e) {
          if (live) setPickerError(e instanceof AgentError && e.reason === REASON.slackNotConnected ? 'disconnected' : 'unavailable')
        }
      })()
    }
    return () => { live = false }
  }, [active, canEdit, reads])

  const status: NotifyView['status'] = !active ? 'idle' : result?.read === reads ? (result.ok ? 'ready' : 'error') : 'loading'

  const save = (next: (l: NotifyChannelList) => { channelIds: string[]; alertsChannelId: string | null }) => {
    if (!list || busy) return
    setBusy(true)
    agent.saveNotifyChannels({ ...next(list), ifRev: list.rev }).then(setList, (e: unknown) => {
      if (e instanceof AgentError && e.code === 'conflict' && !e.reason && e.current) {
        setList(e.current as unknown as NotifyChannelList)
        toast('Someone changed the channel list. It shows the latest now.')
      } else if (e instanceof AgentError && e.reason && SAVE_REFUSED[e.reason]) toast(SAVE_REFUSED[e.reason]!)
      else toast("Couldn't save the channel list. Try again.")
    }).finally(() => setBusy(false))
  }

  const alertsOf = (l: NotifyChannelList) => l.channels.find(c => c.alerts)?.channelId ?? null
  return {
    status, list, available, pickerError, canEdit, busy,
    add: id => save(l => ({ channelIds: [...l.channels.map(c => c.channelId), id], alertsChannelId: alertsOf(l) })),
    remove: id => save(l => ({ channelIds: l.channels.map(c => c.channelId).filter(x => x !== id), alertsChannelId: alertsOf(l) === id ? null : alertsOf(l) })),
    setAlerts: id => save(l => ({ channelIds: l.channels.map(c => c.channelId), alertsChannelId: id })),
    retry: () => setReads(n => n + 1),
  }
}
