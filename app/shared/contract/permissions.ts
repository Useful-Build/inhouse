// Stage 1 M2 (frozen by W0-A; M2-A owns it from wave 1): what the agent may do without asking, and the guardrails that
// always need an exact approval. `grants` already means support grants (grants.ts), so this says permissions. Every
// word a person reads here (`title`, `scope`, `tool.label`) is the server's own, never connector output.
import { z } from 'zod'
import { InstantSchema } from './common.ts'
import { MemberIdSchema } from './members.ts'

/** The rev last read, for an action or a grant: their revs start at 1 (up to 9 digits, as every `ifRev`). */
export const RowIfRevSchema = z.number().int().min(1).max(999_999_999)

/** A permission grant's id: `pg_` + 128 random bits (N10). */
export const PermissionIdSchema = z.string().regex(/^pg_[A-Za-z0-9_-]{22}$/)
export type PermissionId = z.infer<typeof PermissionIdSchema>

/**
 * Why an action needs an exact approval (N9). `money`, `customer`, `destructive` and `access` come from the operation's
 * effects, `bulk` from its record count, `count` from a grant whose use for the day is spent. `unreviewed` and
 * `browser` are for M4; nothing sets them in M2.
 */
export const GuardrailSchema = z.enum(['money', 'customer', 'destructive', 'access', 'bulk', 'count', 'unreviewed', 'browser'])
export type Guardrail = z.infer<typeof GuardrailSchema>

/** The connected tool an action or a grant writes to, as the person sees it: `{ accountId: 'shopify:store', label: 'Shopify (Store A)' }`. */
export const WriteToolRefSchema = z.object({ accountId: z.string(), label: z.string() })
export type WriteToolRef = z.infer<typeof WriteToolRefSchema>

/** Who holds a grant: one member (chat and job turns in that member's own chats), or the brand (no route creates one in M2). */
export const PermissionHolderSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), memberId: MemberIdSchema }),
  z.object({ kind: z.literal('brand') }),
])
export type PermissionHolder = z.infer<typeof PermissionHolderSchema>

/** One live grant, as `permissions()` lists it. `operation` is the server's operation key, opaque to the client. */
export const PermissionSchema = z.object({
  id: PermissionIdSchema,
  rev: z.number().int().min(1),
  holder: PermissionHolderSchema,
  operation: z.string(),
  /** What the agent may do, in plain words: "Add tags to orders". */
  title: z.string(),
  tool: WriteToolRefSchema,
  /** Where it applies, in plain words: "#ops", "Store A". */
  scope: z.string(),
  perDay: z.number().int().min(1),
  grantedBy: MemberIdSchema,
  grantedAt: InstantSchema,
  /** Display only: the server checks again on remove (N15). */
  can: z.object({ remove: z.boolean() }),
})
export type Permission = z.infer<typeof PermissionSchema>

/** `permissions()`: this person's grants and, for an admin, the brand's; newest first. */
export const PermissionsListSchema = z.object({ items: z.array(PermissionSchema) })
export type PermissionsList = z.infer<typeof PermissionsListSchema>

/** `removePermission(id, ifRev)`. */
export const RemovePermissionInputSchema = z.object({ ifRev: RowIfRevSchema }).strict()
export type RemovePermissionInput = z.infer<typeof RemovePermissionInputSchema>
