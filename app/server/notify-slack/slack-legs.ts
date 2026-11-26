// The one switch for both Slack legs of a notice: the agent's `notification_send` post to a listed channel and the
// server's own copy to the alerts channel (`sendSystemNotice`). Closed: a listed channel reaches the run person's bell
// and the alerts copy is skipped, so nothing goes out to Slack and the hub's delivery binding is never called. The
// stages used to decide this (Act opened it); they are retired (Stage 1 plan, M2-F, N17). Wasim answered Q3: the
// agent's Slack posts go through the permission path (a grant or a card), so this opens in M2-N, which builds that path.
// Open it only there. No setting, env value, route or hook may change it: a deployable build ships it as written.
// send.test.ts pins that ./send.ts is the only file that calls the hub's postNotice, so no caller goes around it.
export const SLACK_DELIVERY_ENABLED: boolean = false
