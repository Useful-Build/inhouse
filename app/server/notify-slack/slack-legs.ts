// The one switch for both Slack legs of a notice: the agent's `notification_send` post to a listed channel and the
// server's own copy to the alerts channel (`sendSystemNotice`). Closed: a listed channel reaches the run person's bell
// and the alerts copy is skipped, so nothing goes out to Slack and the hub's delivery binding is never called. The
// stages used to decide this (Act opened it); they are retired (Stage 1 plan, M2-F, N17), and nothing replaces them
// until Wasim answers Q3 (a grant or a card for these posts). Open it only in that PR. No setting, env value, route or
// hook may change it: a deployable build ships it as written.
export const SLACK_DELIVERY_ENABLED: boolean = false
