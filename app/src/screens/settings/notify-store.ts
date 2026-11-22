// The Slack notices page's state (P5 W4): the channel list (route 73) while the page is open, the picker's channels for
// whoever may edit (route 74, page by page), and the saves (route 75), each the whole list with the rev it was read at.
// A plain store with no React, app agent or UI store in it, so its tests drive it with a fake agent; notify-channels.ts
// is the page's hook over it. A refusal says why in a toast, naming the channel, and the list shows as it is now.
import { AgentError } from '../../agent/types'
import type { AgentClient, AvailableChannel, NotifyChannelList } from '../../agent/types'
import { NOTIFY_REASON as REASON } from '../../../shared/contract/error-codes'
import type { ChannelRefusal } from '../../../shared/contract/notify-slack'
import type { NotifyView } from './content'

/** What a refused save says, by reason, with the channel's name (`#name`, or "That channel" when it isn't known). */
export const SAVE_REFUSED = {
  [REASON.sharedChannel]: (n: string) => `${n} is shared with another company, so it can't be listed.`,
  [REASON.archived]: (n: string) => `${n} is archived, so it can't be listed.`,
  [REASON.notPublic]: (n: string) => `${n} isn't public. Only public channels can be listed.`,
  [REASON.notMember]: (n: string) => `The connected Slack account isn't in ${n}. Add it in Slack first.`,
  [REASON.channelNotFound]: (n: string) => `${n} isn't in Slack any more.`,
  [REASON.nameTaken]: (n: string) => `${n} has the same name as another listed channel.`,
  [REASON.slackNotConnected]: () => "Slack isn't connected, or it's paused or needs a reconnect. Check it on the Tools page.",
} as const satisfies Record<ChannelRefusal | typeof REASON.slackNotConnected, (name: string) => string>

export const STALE_TEXT = 'Someone changed the channel list. It shows the latest now.'
export const SAVE_FAILED = "Couldn't save the channel list. Try again."

/** The most picker pages read (200 channels each, so 2,000 channels). */
export const MAX_PAGES = 10

export type NotifyAgent = Pick<AgentClient, 'listNotifyChannels' | 'availableNotifyChannels' | 'saveNotifyChannels'>

export type NotifyState = Pick<NotifyView, 'status' | 'list' | 'available' | 'pickerError' | 'pickerLoading' | 'truncated' | 'busy'>

const IDLE: NotifyState = { status: 'idle', list: null, available: null, pickerError: null, pickerLoading: false, truncated: false, busy: false }

export function createNotifyStore(deps: { agent: NotifyAgent; toast: (text: string) => void; maxPages?: number }) {
  const maxPages = deps.maxPages ?? MAX_PAGES
  let s: NotifyState = IDLE
  let gen = 0
  let open = false
  let canEdit = false
  const listeners = new Set<() => void>()
  const set = (p: Partial<NotifyState>) => {
    s = { ...s, ...p }
    for (const l of listeners) l()
  }

  function read(): Promise<void> {
    const g = ++gen
    set({ status: 'loading', ...(canEdit ? { pickerLoading: true, pickerError: null } : {}) })
    const list = deps.agent.listNotifyChannels().then(
      l => { if (g === gen) set({ list: l, status: 'ready' }) },
      () => { if (g === gen) set({ status: 'error' }) },
    )
    if (!canEdit) return list
    const picker = (async () => {
      const all: AvailableChannel[] = []
      let cursor: string | undefined
      let truncated = false
      try {
        for (let i = 0; ; i++) {
          if (i === maxPages) {
            truncated = true
            break
          }
          const page = await deps.agent.availableNotifyChannels(cursor)
          all.push(...page.channels)
          if (!page.nextCursor) break
          cursor = page.nextCursor
        }
        if (g === gen) set({ available: all, truncated, pickerError: null, pickerLoading: false })
      } catch (e) {
        if (g === gen) set({ pickerError: e instanceof AgentError && e.reason === REASON.slackNotConnected ? 'disconnected' : 'unavailable', pickerLoading: false })
      }
    })()
    return Promise.all([list, picker]).then(() => undefined)
  }

  /** `#name` of a channel the page knows (listed or offered), else "That channel". */
  const nameOf = (current: Record<string, unknown> | undefined): string => {
    const id = typeof current?.channelId === 'string' ? current.channelId : null
    const known = id ? (s.list?.channels.find(c => c.channelId === id) ?? s.available?.find(c => c.channelId === id)) : undefined
    return known ? `#${known.name}` : 'That channel'
  }

  async function save(next: (l: NotifyChannelList) => { channelIds: string[]; alertsChannelId: string | null }): Promise<void> {
    const l = s.list
    if (!l || s.busy) return
    set({ busy: true })
    try {
      set({ list: await deps.agent.saveNotifyChannels({ ...next(l), ifRev: l.rev }) })
    } catch (e) {
      if (e instanceof AgentError && e.code === 'conflict' && !e.reason) {
        // A stale rev: the latest list, from the answer when it carried one, else read again.
        if (e.current) set({ list: e.current as unknown as NotifyChannelList })
        else if (open) void read()
        deps.toast(STALE_TEXT)
      } else if (e instanceof AgentError && e.reason && Object.hasOwn(SAVE_REFUSED, e.reason)) {
        deps.toast(SAVE_REFUSED[e.reason as keyof typeof SAVE_REFUSED](nameOf(e.current)))
      } else deps.toast(SAVE_FAILED)
    } finally {
      set({ busy: false })
    }
  }

  const alertsOf = (l: NotifyChannelList) => l.channels.find(c => c.alerts)?.channelId ?? null
  return {
    subscribe(l: () => void) {
      listeners.add(l)
      return () => { listeners.delete(l) }
    },
    getSnapshot: () => s,
    /** The page opened (or who may edit changed): read. The returned close drops answers still on their way. */
    open(edit: boolean): () => void {
      open = true
      canEdit = edit
      void read()
      return () => {
        open = false
        gen++
      }
    },
    retry: (): Promise<void> => (open ? read() : Promise.resolve()),
    add: (id: string) => save(l => ({ channelIds: [...l.channels.map(c => c.channelId), id], alertsChannelId: alertsOf(l) })),
    remove: (id: string) => save(l => ({ channelIds: l.channels.map(c => c.channelId).filter(x => x !== id), alertsChannelId: alertsOf(l) === id ? null : alertsOf(l) })),
    setAlerts: (id: string | null) => save(l => ({ channelIds: l.channels.map(c => c.channelId), alertsChannelId: id })),
  }
}

export type NotifyStore = ReturnType<typeof createNotifyStore>

