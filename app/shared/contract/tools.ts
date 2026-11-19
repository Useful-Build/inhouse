// The tools the agent reads, the channels it posts to and the tool catalog.
import { z } from 'zod'
import { StageIndexSchema } from './common.ts'
import { AttachmentSchema } from './chat.ts'

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
  since: z.string(),
})
export type ToolDetail = z.infer<typeof ToolDetailSchema>

export const CatalogToolSchema = z.object({ k: z.string(), name: z.string(), desc: z.string(), need: StageIndexSchema.optional() })
export type CatalogTool = z.infer<typeof CatalogToolSchema>

/** A channel the team hears from the agent on (Slack): not a tool it reads. Decision D6. */
export const ToolChannelSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** What it's for, as one line. */
  desc: z.string(),
  /** The stage it starts at: shown as included from that stage below it. */
  need: StageIndexSchema,
  /** When it was connected, as shown ("Nov 2"). */
  since: z.string(),
  site: z.string(),
  /** Where it reaches the team ("#ops"). */
  channel: z.string().optional(),
  /** What reaches that channel, as short phrases. */
  sends: z.array(z.string()).optional(),
  /** Who can ask the agent there. */
  ask: z.string().optional(),
})
export type ToolChannel = z.infer<typeof ToolChannelSchema>

export const ToolsDataSchema = z.object({
  /** The six tools Inhouse agent reads, in display order. */
  connected: z.array(z.string()),
  /** Connected channels the team hears from the agent on (Slack, from Act): not tools it reads. Decision D6. */
  channels: z.array(ToolChannelSchema),
  beingConnected: z.array(z.string()),
  /** Sample records the composer's "An order, product or customer" item attaches (the first one). None: the item is hidden. */
  attachExamples: z.array(AttachmentSchema.extend({ sources: z.array(z.string()), label: z.string().optional() })).optional(),
  lastRead: z.intersection(z.record(z.string(), z.string()), z.object({ default: z.string() })),
  catalog: z.array(CatalogToolSchema),
  details: z.record(z.string(), ToolDetailSchema),
})
export type ToolsData = z.infer<typeof ToolsDataSchema>
