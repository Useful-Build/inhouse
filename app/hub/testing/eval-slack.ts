// The eval deployment's fake Slack workspace (Stage 1 M3, N31; Wasim's option A, 2026-11-27). The eval hub is the hub's
// test build, so its Slack is already the fake one (test/upstreams/mcp/server.ts, served through the seam): no Slack
// credential and no outside request. On the eval hub only, that fake serves the workspace the eval door seeded per case
// (evals/targets/slack-door.ts: channels and planted messages, migration 0792) instead of the per-PR fixture, read from
// the eval D1 before each request, so a planted Slack message reaches the agent's Slack read tools. Posts never come
// here: `slack.channel.post` goes through the outbox to EvalWriteGateway (./eval-write.ts) and lands in eval_write_log.
//
// Rules:
// - Reached only from ./index.ts (the seam), itself only by the guarded dynamic import, so the deployable bundle never
//   carries this module: scripts/check-hub-build.mjs fails a deployable bundle that holds EVAL_SLACK_CANARY, and fails
//   unless the test bundle holds it.
// - Switched on by one binding, EVAL_WRITE_LOG (the eval D1), which only the eval hub's config may bind
//   (scripts/check-product-config.mjs EVAL_WRITE_LOG_BINDING). Without it (every per-PR test hub) the fixture is served.
// - Reads only that binding and only its two tables; no outside request, no credential name (eval-slack.test.ts reads
//   this file). A row the schema should have refused throws: the fake then answers an upstream failure, never the fixture.

/** Found in the hub's test bundle, never in the deployable one (scripts/check-hub-build.mjs reads it from here). */
export const EVAL_SLACK_CANARY = 'INHOUSE_EVAL_SLACK_CANARY_5d1e'

/** The one binding this module reads: the eval deployment's own D1 (the eval hub config alone binds it). */
export interface EvalSlackEnv {
  EVAL_WRITE_LOG?: D1Database
}

/** The channels and messages as the fake serves them (test/upstreams/mcp/server.ts FakeSlackWorkspace). */
export interface EvalSlackWorkspace {
  channels: { id: string; name: string; private: boolean }[]
  messages: { channel: string; ts: string; user: string; text: string; thread?: string }[]
}

const CHANNEL_ID = /^C[A-Z0-9]{2,20}$/
const TS = /^\d{1,12}\.\d{1,8}$/
const USER_ID = /^U[A-Z0-9]{2,20}$/

type ChannelRow = { channel_id: unknown; name: unknown; is_private: unknown }
type MessageRow = { ts: unknown; channel_id: unknown; user_id: unknown; text: unknown; thread_ts: unknown }

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`eval slack: ${what} is not text`)
  return v
}
const shaped = (v: unknown, re: RegExp, what: string): string => {
  const s = str(v, what)
  if (!re.test(s)) throw new Error(`eval slack: ${what} is malformed`)
  return s
}

/** The workspace on `db` now: every channel, and every message, oldest first. */
export async function loadEvalSlack(db: D1Database): Promise<EvalSlackWorkspace> {
  const [channels, messages] = await db.batch<ChannelRow | MessageRow>([
    db.prepare('SELECT channel_id, name, is_private FROM eval_slack_channel ORDER BY channel_id'),
    db.prepare('SELECT ts, channel_id, user_id, text, thread_ts FROM eval_slack_message ORDER BY CAST(ts AS REAL), ts'),
  ])
  const ws: EvalSlackWorkspace = {
    channels: (channels!.results as ChannelRow[]).map(r => ({
      id: shaped(r.channel_id, CHANNEL_ID, 'a channel id'),
      name: str(r.name, 'a channel name'),
      private: r.is_private === 1,
    })),
    messages: (messages!.results as MessageRow[]).map(r => {
      const m: EvalSlackWorkspace['messages'][number] = {
        channel: shaped(r.channel_id, CHANNEL_ID, 'a message\'s channel'),
        ts: shaped(r.ts, TS, 'a message ts'),
        user: shaped(r.user_id, USER_ID, 'a message\'s user'),
        text: str(r.text, 'a message text'),
      }
      if (r.thread_ts !== null) m.thread = shaped(r.thread_ts, TS, 'a thread ts')
      return m
    }),
  }
  return ws
}

/** The workspace the Slack fake serves now: the eval D1's on the eval hub, else null (the fixture). */
export async function evalSlackWorkspace(env: EvalSlackEnv | undefined): Promise<EvalSlackWorkspace | null> {
  const db = env?.EVAL_WRITE_LOG
  return db ? loadEvalSlack(db) : null
}
