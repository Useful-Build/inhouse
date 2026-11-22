// P6a (W2): team memory approval. A brand fact the agent saved or reworded waits (`waiting`) until an Admin, or the
// Inhouse team under a live grant, approves that exact revision (`active`) or rejects it (`forgotten`).
import { z } from 'zod'
import { MemoryForgetInputSchema, MemoryLineSchema } from './memory.ts'

/**
 * `PUT /api/memory/brand/:id/approved` (route 78): approve (`true`) or reject (`false`) a waiting team fact, at the
 * rev last read. A stale rev, or a fact that no longer waits, answers `conflict` with the fact as it is.
 */
export const MemoryApproveInputSchema = z.object({ approved: z.boolean(), ifRev: MemoryForgetInputSchema.shape.ifRev }).strict()
export type MemoryApproveInput = z.infer<typeof MemoryApproveInputSchema>

/** A team fact waiting for an OK. `kind` lets P6b's Approvals list show facts beside actions. */
export const WaitingMemorySchema = MemoryLineSchema.extend({ kind: z.literal('memory') })
export type WaitingMemory = z.infer<typeof WaitingMemorySchema>

/** `GET /api/memory/waiting` (route 77): the brand's waiting facts, newest first, at most 200. */
export const WaitingMemoryListSchema = z.object({ facts: z.array(WaitingMemorySchema) })
export type WaitingMemoryList = z.infer<typeof WaitingMemoryListSchema>
