// The Slack notice channels over HTTP (P5 W4, p5-w4.md section 10): route 73 reads the list, 74 one page of the channels
// the connected Slack account can pick from, 75 saves the whole list with the rev it was read at. Plain code, no zod (the
// entry's size budget, schemas.ts): the transport parses each answer with the lazily loaded schemas, and the save's
// body is built from them by the caller's `Contract`. Refusals reject with an AgentError (`conflict` and its reason).
import type { AvailableChannels, NotifyChannelList, PutNotifyChannels } from '../../../shared/contract/notify-slack'
import type { Contract, Transport } from './transport'

const PATH = '/api/notify/channels'

/** Route 73. */
export const readNotifyChannels = (http: Transport): Promise<NotifyChannelList> => http.call({ method: 'GET', path: PATH, schema: 'notifyChannels' })

/** Route 74: one page; `cursor` is the last page's `nextCursor`. */
export const readAvailableChannels = (http: Transport, cursor?: string): Promise<AvailableChannels> =>
  http.call({ method: 'GET', path: cursor ? `${PATH}/available?cursor=${encodeURIComponent(cursor)}` : `${PATH}/available`, schema: 'availableChannels' })

/** Route 75: the whole list. A stale `ifRev` rejects with `conflict` and the current list as `current`. */
export const putNotifyChannels = (http: Transport, k: Contract, input: PutNotifyChannels): Promise<NotifyChannelList> =>
  http.call({ method: 'PUT', path: PATH, schema: 'notifyChannels', json: k.BODIES.notifyChannels.parse(input) })
