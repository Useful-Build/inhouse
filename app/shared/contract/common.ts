// Values every resource shares: the stages, the demo scenarios, a model's effort and the error codes.
import { z } from 'zod'

export const StageSchema = z.enum(['Watch', 'Act', 'Run'])
export type Stage = z.infer<typeof StageSchema>

/** 0 Watch, 1 Act, 2 Run. `need` fields in the sample data use the same index. */
export const StageIndexSchema = z.union([z.literal(0), z.literal(1), z.literal(2)])
export type StageIndex = z.infer<typeof StageIndexSchema>

export const ScenarioSchema = z.enum(['Normal', 'First day', 'Loading', 'Tool disconnected', 'Cap reached'])
export type Scenario = z.infer<typeof ScenarioSchema>

/** How hard a model thinks, as the engine names it. */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortSchema>

export const AgentErrorCodeSchema = z.enum(['offline', 'forbidden', 'conflict', 'unknown'])
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>

/** Two strings shown side by side: a label and its value, or a text and its source number. */
export const PairSchema = z.tuple([z.string(), z.string()])
