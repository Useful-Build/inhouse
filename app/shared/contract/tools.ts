// The tools the agent reads, the channels it posts to and the tool catalog.
import { z } from 'zod'
import { InstantSchema, StageIndexSchema } from './common.ts'
import { AttachmentSchema } from './chat.ts'
import { ConnectionIdSchema, ConnectionPathSchema, ConnectionStateSchema } from './connections.ts'

/**
 * Stage 1 M4 (N35; M4-R2 merges it into the Tools list, M4-U2a shows it): a tool connected by address, as its page
 * reads it. `state`: the hub's word ("Sign in again", "Needs a new key"). `changed`: how many of its confirmed tools
 * are hidden because they changed ("Tools changed"). `adminMaySignIn` with a waiting state: an Admin's step.
 */
export const ToolConnectionDetailSchema = z.object({
  id: ConnectionIdSchema,
  state: ConnectionStateSchema,
  path: ConnectionPathSchema,
  trusted: z.boolean(),
  adminMaySignIn: z.boolean(),
  changed: z.number().int().min(0),
})
export type ToolConnectionDetail = z.infer<typeof ToolConnectionDetailSchema>

export const ToolDetailSchema = z.object({
  name: z.string(),
  desc: z.string(),
  progress: z.boolean().optional(),
  ex: z.array(z.string()),
  read: z.string(),
  draft: z.string(),
  run: z.string(),
  conn: z.string(),
  site: z.string(),
  /** When the Inhouse team connected it. Missing while it is being connected. */
  since: InstantSchema.optional(),
  /** A tool being connected: when it goes live. */
  liveBy: InstantSchema.optional(),
  /** P5: the hub's account id (`slack:workspace`). The client sends this, never the connector key, to the connect, pause and disconnect routes. */
  accountId: z.string().optional(),
  /** P5: the member id of who connected it. */
  connectedBy: z.string().optional(),
  /** P5: the Inhouse team can disconnect it here (OAuth tools only; a tool set up in the deployment's config can't be). */
  canDisconnect: z.boolean().optional(),
  /** P5: the last disconnect couldn't revoke the tool's access at its source: the team removes the app there too. */
  revokeFailed: z.boolean().optional(),
  /** P5: the Inhouse team paused it: still connected, not read. */
  paused: z.boolean().optional(),
  /** P5: its first login failed and it was never connected (so it isn't in `connected`): when, from the hub's error. */
  loginFailedAt: InstantSchema.optional(),
  /**
   * Stage 1 M2-I: a write operation on this tool is enabled for the brand (`permission_ceiling`), so the agent may ask to
   * act on it. Never in a deployable build in M1 and M2 (N2). The product's tool page offers drafting only then.
   */
  acts: z.boolean().optional(),
  /** Stage 1 M4: a tool connected by address (absent for a built-in tool). */
  connection: ToolConnectionDetailSchema.optional(),
})
export type ToolDetail = z.infer<typeof ToolDetailSchema>

export const CatalogToolSchema = z.object({
  k: z.string(), name: z.string(), desc: z.string(), need: StageIndexSchema.optional(),
  /** P5: the hub's account id, on a tool the Inhouse team can connect here. The client sends it to the connect route. */
  accountId: z.string().optional(),
})
export type CatalogTool = z.infer<typeof CatalogToolSchema>

/** A channel the team hears from the agent on (Slack): not a tool it reads. Decision D6. */
export const ToolChannelSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** What it's for, as one line. */
  desc: z.string(),
  /** The stage it starts at: shown as included from that stage below it. */
  need: StageIndexSchema,
  /** When it was connected. */
  since: InstantSchema,
  site: z.string(),
  /** Where it reaches the team ("#ops"). */
  channel: z.string().optional(),
  /** What reaches that channel, as short phrases. */
  sends: z.array(z.string()).optional(),
  /** Who can ask the agent there. */
  ask: z.string().optional(),
})
export type ToolChannel = z.infer<typeof ToolChannelSchema>

/** A connected tool the agent can't read now: its login failed (`disconnected`) at `since`. */
export const ToolConnectionSchema = z.object({ status: z.literal('disconnected'), since: InstantSchema })
export type ToolConnection = z.infer<typeof ToolConnectionSchema>

/** A tool the Inhouse team is setting up: when it should connect, counted in the brand's days from today. */
export const ToolSetupSchema = z.object({ due: z.enum(['today', 'tomorrow', 'this-week']) })
export type ToolSetup = z.infer<typeof ToolSetupSchema>

export const ToolsDataSchema = z.object({
  /**
   * The tools Inhouse agent reads, in display order. Empty only before the brand's first tool is live: the UI reads an
   * empty list on a ready agent as day one. A tool whose login fails stays listed and is reported in `connection`.
   */
  connected: z.array(z.string()),
  /** Connected channels the team hears from the agent on (Slack, from Act): not tools it reads. Decision D6. */
  channels: z.array(ToolChannelSchema),
  beingConnected: z.array(z.string()),
  /** Sample records the composer's "An order, product or customer" item attaches (the first one). None: the item is hidden. */
  attachExamples: z.array(AttachmentSchema.extend({ sources: z.array(z.string()), label: z.string().optional() })).optional(),
  /** When the agent last read each tool, by key; `default` for every tool not listed. */
  lastRead: z.intersection(z.record(z.string(), InstantSchema), z.object({ default: InstantSchema })),
  catalog: z.array(CatalogToolSchema),
  details: z.record(z.string(), ToolDetailSchema),
  /** Connected tools the agent can't read now, by key, with since when. A tool not listed reads as `connected` says. */
  connection: z.record(z.string(), ToolConnectionSchema),
  /**
   * Before the first tool is live: the tools the Inhouse team is setting up, by key, each with when it should connect.
   * Every key is in `beingConnected`, which gives their order. Empty once the agent has a tool to read.
   */
  setup: z.record(z.string(), ToolSetupSchema),
  /** How many of `connected` the morning check has read so far: all of them once the agent's data is ready. */
  readDone: z.number().int().nonnegative(),
})
export type ToolsData = z.infer<typeof ToolsDataSchema>

/** Route D's body: `PUT /api/tools/:accountId/paused`. A boolean set, so a repeat changes nothing. */
export const ToolPausedInputSchema = z.object({ paused: z.boolean() }).strict()
export type ToolPausedInput = z.infer<typeof ToolPausedInputSchema>
/** Route D's answer: the state after the change. */
export const ToolPausedResultSchema = z.object({ paused: z.boolean() })
export type ToolPausedResult = z.infer<typeof ToolPausedResultSchema>

/** Route E's answer. `revoked: false`: the tool's access wasn't revoked at its source (the team removes the app there). */
export const ToolDisconnectResultSchema = z.object({ revoked: z.boolean() })
export type ToolDisconnectResult = z.infer<typeof ToolDisconnectResultSchema>

/** Route A's answer (W1): where the browser goes to sign in to the tool. */
export const ToolConnectResultSchema = z.object({ authorizeUrl: z.string().min(1) })
export type ToolConnectResult = z.infer<typeof ToolConnectResultSchema>
