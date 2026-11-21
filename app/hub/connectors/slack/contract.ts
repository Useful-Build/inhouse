// The DeliveryGateway contract (P5 W4, p5-w4.md section 6). Plain TypeScript types with type-only imports, so the
// product Worker can `import type` this file without the hub's dependencies. Product Worker server code only, bound as
// `HUB_DELIVERY`; `scope.kind` must be `server` on every method. Nothing here returns a token or an upstream body.
import type { CallerScope, HubResult } from '../../index/contract'
import type { LinkKind } from '../../../shared/notify/links'

export type SlackChannel = { id: string; name: string; isMember: boolean; shared: boolean; archived: boolean; private: boolean }

/** The one account delivery serves. */
export type DeliveryAccountId = 'slack:workspace'

export type PostNoticeRequest = {
  accountId: DeliveryAccountId
  channelId: string
  /** Bounded but unescaped (the hub escapes once). */
  title: string
  text: string
  link?: { kind: LinkKind; id?: string }
  /** The server's notice id, for the logs' correlation only. */
  noticeId: string
}

/** Why `postNotice` refused a channel: the `connect_refused` error's detail. */
export type ChannelRefusal = 'shared_channel' | 'archived' | 'not_public' | 'not_member' | 'not_found'

export interface DeliveryGateway {
  postNotice(scope: CallerScope, req: PostNoticeRequest): Promise<HubResult<{ ts: string }>>
  listChannels(scope: CallerScope, req: { accountId: DeliveryAccountId; cursor?: string }): Promise<HubResult<{ channels: SlackChannel[]; nextCursor: string | null }>>
  checkChannel(scope: CallerScope, req: { accountId: DeliveryAccountId; channelId: string }): Promise<HubResult<SlackChannel>>
}

/** What `slackPost` takes (the SignIn stub method), and so `postToSlack` (P6 W5's outbox). */
export type SlackPostRequest = { channelId: string; title: string; text: string; link?: { kind: LinkKind; id?: string } }
