// DeliveryGateway's logic (P5 W4, p5-w4.md section 6) as plain functions over the Slack SignIn stub, so the Node project
// tests it without workerd. delivery.ts is the WorkerEntrypoint over these. `scope.kind` must be `server` on every
// method: the runner's `run` scope is refused. Every argument is checked; the post goes through `postToSlack`. Every
// SignIn answer is returned as plain data, released (`settledAnswer`), never passed on as is.
import type { CallerScope, HubResult } from '../../index/contract'
import { err } from '../../index/errors'
import { CallerScopeSchema } from '../../index/schemas'
import type { PostNoticeRequest, SlackChannel } from './contract'
import { postToSlack, SLACK_ACCOUNT, type SlackPostStub } from './post'
import { settledAnswer } from '../../../shared/rpc-answer'

export type DeliveryStub = SlackPostStub & {
  slackChannelInfo(accountId: string, channelId: string): Promise<HubResult<SlackChannel>>
  slackChannelList(accountId: string, cursor?: string): Promise<HubResult<{ channels: SlackChannel[]; nextCursor: string | null }>>
}

export type DeliveryDeps = { signIn(accountId: string): DeliveryStub }

const NOTICE_ID = /^n_[A-Za-z0-9_-]{22}$/

function serverScope(scope: unknown): boolean {
  const parsed = CallerScopeSchema.safeParse(scope)
  return parsed.success && parsed.data.kind === 'server'
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export async function postNotice(deps: DeliveryDeps, scope: CallerScope, req: PostNoticeRequest): Promise<HubResult<{ ts: string }>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (!isObject(req)) return err('invalid_args')
  if (req.accountId !== SLACK_ACCOUNT) return err('invalid_args', 'accountId')
  if (typeof req.noticeId !== 'string' || !NOTICE_ID.test(req.noticeId)) return err('invalid_args', 'noticeId')
  if (typeof req.channelId !== 'string' || typeof req.title !== 'string' || typeof req.text !== 'string') return err('invalid_args')
  if (req.link !== undefined && !isObject(req.link)) return err('invalid_args', 'link')
  return settledAnswer(postToSlack(deps.signIn(SLACK_ACCOUNT), { channelId: req.channelId, title: req.title, text: req.text, link: req.link }))
}

export async function listChannels(deps: DeliveryDeps, scope: CallerScope, req: { accountId: string; cursor?: string }): Promise<HubResult<{ channels: SlackChannel[]; nextCursor: string | null }>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (!isObject(req) || req.accountId !== SLACK_ACCOUNT) return err('invalid_args', 'accountId')
  if (req.cursor !== undefined && typeof req.cursor !== 'string') return err('invalid_args', 'cursor')
  return settledAnswer(deps.signIn(SLACK_ACCOUNT).slackChannelList(SLACK_ACCOUNT, req.cursor))
}

export async function checkChannel(deps: DeliveryDeps, scope: CallerScope, req: { accountId: string; channelId: string }): Promise<HubResult<SlackChannel>> {
  if (!serverScope(scope)) return err('invalid_args', 'scope')
  if (!isObject(req) || req.accountId !== SLACK_ACCOUNT) return err('invalid_args', 'accountId')
  if (typeof req.channelId !== 'string') return err('invalid_args', 'channelId')
  return settledAnswer(deps.signIn(SLACK_ACCOUNT).slackChannelInfo(SLACK_ACCOUNT, req.channelId))
}
