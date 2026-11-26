// The delivery types inside the hub. The DeliveryGateway contract itself lives in index/contract.ts (no imports, so the
// product Worker can `import type` it); this file adds the SignIn method's request.
import type { NoticeLinkKind } from '../../index/contract'

export type { DeliveryGateway, PostNoticeRequest, SlackChannel } from '../../index/contract'

/** Why `postNotice` refused a channel: the `connect_refused` error's detail. */
export type ChannelRefusal = 'shared_channel' | 'archived' | 'not_public' | 'not_member' | 'not_found'

/** What `slackPost` takes (the SignIn stub method), and so `postToSlack` (P6 W5's outbox). */
export type SlackPostRequest = { channelId: string; title: string; text: string; link?: { kind: NoticeLinkKind; id?: string } }

/**
 * Stage 1 M2-C (N13): what an outbox post expects of the account. When given, the SignIn re-reads paused, state, scopes
 * and `connectedAtMs` synchronously right before `chat.postMessage` and refuses if any changed. Delivery passes none.
 */
export type SlackPostExpect = { connectedAtMs: number }
