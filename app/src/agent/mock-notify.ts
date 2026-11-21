// The demo's Slack notice channels (P5 W4), loaded by the demo agent on first use (mock.ts), so Today's first load
// carries none of it. Kept in memory only: a reload or Reset demo starts again from none listed. The demo's Slack has
// invented channels, one shared with another company and one the connected account isn't in, so the page shows both
// refusals. Refusals reject with an AgentError and no notice: the page says why itself.
import { NOTIFY_REASON as REASON } from '../../shared/contract/error-codes'
import type { AvailableChannels, NotifyChannel, NotifyChannelList, PutNotifyChannels } from '../../shared/contract/notify-slack'
import { AgentError } from './types'

/** The demo's Slack channels (invented). */
const DEMO_SLACK_CHANNELS = [
  { id: 'C0DEMO0001', name: 'ops-alerts', shared: false, member: true },
  { id: 'C0DEMO0002', name: 'warehouse', shared: false, member: true },
  { id: 'C0DEMO0003', name: 'supplier-kestrel', shared: true, member: true },
  { id: 'C0DEMO0004', name: 'design', shared: false, member: false },
] as const

let rev = 0
let listed: NotifyChannel[] = []

const refuse = (code: 'conflict' | 'invalid', text: string, extra: ConstructorParameters<typeof AgentError>[2] = {}): Promise<never> =>
  Promise.reject(new AgentError(code, text, extra))

export const demoNotify = {
  list(): Promise<NotifyChannelList> {
    return Promise.resolve({ rev, channels: listed.map(c => ({ ...c })) })
  },
  available(): Promise<AvailableChannels> {
    return Promise.resolve({
      channels: DEMO_SLACK_CHANNELS.map(c => ({ channelId: c.id, name: c.name, ...(c.shared ? { disabled: REASON.sharedChannel } : !c.member ? { disabled: REASON.notMember } : {}) })),
      nextCursor: null,
    })
  },
  save(input: PutNotifyChannels): Promise<NotifyChannelList> {
    if (input.ifRev !== rev) return refuse('conflict', 'Someone changed the channel list.', { current: { rev, channels: listed.map(c => ({ ...c })) } })
    const ids = [...new Set(input.channelIds)]
    if (ids.length > 50) return refuse('invalid', 'List at most 50 channels.')
    const found = ids.map(id => DEMO_SLACK_CHANNELS.find(c => c.id === id))
    const missing = ids.find((_, i) => !found[i])
    if (missing) return refuse('conflict', "That channel isn't in Slack any more.", { reason: REASON.channelNotFound, current: { channelId: missing } })
    const refused = found.find(c => c!.shared || !c!.member)
    if (refused) return refuse('conflict', "That channel can't be listed.", { reason: refused.shared ? REASON.sharedChannel : REASON.notMember, current: { channelId: refused.id } })
    const alerts = input.alertsChannelId ?? null
    if (alerts !== null && !ids.includes(alerts)) return refuse('invalid', 'The alerts channel must be one of the listed channels.')
    // The server's order: lowercase name, then id.
    const order = (a: NotifyChannel, b: NotifyChannel) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : a.channelId < b.channelId ? -1 : a.channelId > b.channelId ? 1 : 0)
    listed = found.map(c => ({ channelId: c!.id, name: c!.name, alerts: c!.id === alerts })).sort(order)
    rev += 1
    return this.list()
  },
}
