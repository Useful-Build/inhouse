// The poster (P5 W4, p5-w4.md section 6): the one way any hub code posts to Slack, P6 W5's outbox included. A thin
// wrapper over the Slack SignIn's `slackPost`, so every caller gets the id check, the channel re-check at Slack, the
// bounds with the one escape and the fixed parameters by construction. The request is rebuilt from its four keys, so
// nothing else a caller puts on it reaches the SignIn.
import type { HubResult } from '../../index/contract'
import type { SlackPostRequest } from './contract'

export const SLACK_ACCOUNT = 'slack:workspace' as const

/** The Slack SignIn stub method the poster calls (`signInFor(env, SLACK_ACCOUNT)`). */
export type SlackPostStub = { slackPost(accountId: string, req: SlackPostRequest): Promise<HubResult<{ ts: string }>> }

export function postToSlack(signIn: SlackPostStub, req: SlackPostRequest): Promise<HubResult<{ ts: string }>> {
  const clean: SlackPostRequest = { channelId: req.channelId, title: req.title, text: req.text }
  if (req.link !== undefined) clean.link = req.link
  return signIn.slackPost(SLACK_ACCOUNT, clean)
}
