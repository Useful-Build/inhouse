// `read()`: the read-only snapshot of everything the UI reads besides AgentState.
import { z } from 'zod'
import { PairSchema } from './common.ts'
import { AgentMetaSchema } from './meta.ts'
import { ProblemSchema } from './problem.ts'
import { ToolsDataSchema } from './tools.ts'
import { RoutineDefSchema } from './routine.ts'
import { SkillDefSchema, SkillSuggestionSchema } from './skill.ts'
import { UsageDataSchema } from './usage.ts'
import { PeopleDataSchema } from './people.ts'
import { MemoryDataSchema } from './memory.ts'
import { ActivityLineSchema, AuditEntrySchema } from './activity.ts'
import { ModelModeSchema } from './model.ts'
import { ChatDataSchema } from './chat.ts'
import { LibraryPlaceSchema } from './library.ts'

/**
 * Read-only snapshot of everything the UI reads besides AgentState: sample data in the mock,
 * data from the Worker in phase 2. A real client caches it and calls `subscribe` listeners on change.
 */
export const AgentDataSchema = z.object({
  /** `loading` until the agent's data has arrived: lists are empty then. The mock is `loading` only in the Loading scenario. */
  status: z.enum(['loading', 'ready']),
  meta: AgentMetaSchema,
  problems: z.array(ProblemSchema),
  tools: ToolsDataSchema,
  routines: z.array(RoutineDefSchema),
  skills: z.array(SkillDefSchema),
  skillSuggestions: z.array(SkillSuggestionSchema),
  /** The heading over `skillSuggestions` ("Suggested for Shopify brands"). Missing: "Suggested for you". */
  skillSuggestionsTitle: z.string().optional(),
  usage: UsageDataSchema,
  /** Usage by month for the month picker, newest first. The first one is `usage`. */
  usageMonths: z.array(UsageDataSchema),
  people: PeopleDataSchema,
  memory: MemoryDataSchema,
  auditLog: z.array(AuditEntrySchema),
  /** The fixed lines of Activity. Today's approvals and handled jobs come from state. */
  activity: z.object({ today: z.array(ActivityLineSchema), earlier: z.array(ActivityLineSchema) }),
  notifications: z.object({
    teamRequests: z.array(z.object({ title: z.string(), sub: z.string(), status: z.string() })),
  }),
  scenarios: z.object({
    firstDay: z.object({ setup: z.array(PairSchema) }),
    /** The Loading scenario: how many tools the morning check has read so far. */
    loading: z.object({ readDone: z.number() }),
    /** The Tool disconnected scenario: which tool lost its login, and when (shown). */
    toolDisconnected: z.object({ tool: z.string(), at: z.string() }),
  }),
  models: z.array(ModelModeSchema),
  defaultModel: z.string(),
  chat: ChatDataSchema,
  library: z.object({ places: z.array(LibraryPlaceSchema) }),
  /** Help and guides, from the account menu. */
  help: z.array(z.object({ icon: z.string(), title: z.string(), text: z.string() })),
})
export type AgentData = z.infer<typeof AgentDataSchema>
