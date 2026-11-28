// Stage 1 M4 (M4-A): every list or record keyed by one of the shared closed sets covers every member, so a member added
// to the set (an M4 package's new hub code, guardrail, operation, effect flag or connector) can't be missed by a list
// that names them one by one. Each set's members are written out once below under a mapped type, so the compiler fails
// this file when the set gains or loses a member; each list is then compared with them, both ways.
// Ways it can go wrong, written first:
//  1. a list that names hub codes (the egress's relay list, the audit's outcomes, the hub's schema) misses a new code,
//     so it's answered as `internal` or a line is refused;
//  2. a guardrail has no words where a card or a line says why it's exact;
//  3. a write operation is missing from a written-out list (the audit's, the hub's schema, the words tables);
//  4. an effect flag is in `Effects` but not in a guardrail list (so it never names its guardrail), or an entry's effects
//     miss a flag;
//  5. a connector has no label on a screen, or an account connector has no account id.
import { describe, expect, it } from 'vitest'
import type { HubErrorCode, WriteOperationKey } from '../hub/index/contract.ts'
import { WRITE_OPERATIONS } from '../hub/index/contract.ts'
import { HubErrorCodeSchema, WriteOperationKeySchema } from '../hub/index/schemas.ts'
import { auditText } from '../shared/audit-text.ts'
import { OPERATION_LIMITS, OPERATION_TITLE } from '../shared/audit-text.ts'
import { ActionFailCodeSchema, ConnectOutcomeSchema, WriteOperationArgSchema } from '../shared/contract/audit.ts'
import type { Guardrail } from '../shared/contract/permissions.ts'
import { GuardrailSchema } from '../shared/contract/permissions.ts'
import { EFFECT_GUARDRAILS as CEILING_GUARDRAILS, TOOL as CEILING_TOOL } from './api/ceiling-store.ts'
import { HUB_ERROR_CODES } from './egress/hub.ts'
import { ACCOUNT_IDS } from './outbox/facts.ts'
import { OPERATION_KEYS, OPERATIONS } from './outbox/operations/index.ts'
import type { AccountConnector, Effects, OperationConnector } from './outbox/operations/types.ts'
import { EFFECT_GUARDRAILS } from './permissions/decide.ts'
import { OPERATION_WORDS } from './prompt/actions.ts'

// ---- each set's members, once; the mapped types make the compiler check them against the set ----
const HUB_CODES: { [K in HubErrorCode]: true } = {
  invalid_args: true, unknown_tool: true, write_refused: true, not_configured: true, credentials_rejected: true, scope_mismatch: true,
  key_unavailable: true, upstream_unavailable: true, upstream_rejected: true, upstream_version_mismatch: true, rate_limited: true,
  result_too_large: true, internal: true, state_invalid: true, workspace_mismatch: true, connect_stale: true, connect_refused: true, paused: true,
  needs_key: true, definition_changed: true, needs_input: true, leak: true, client_fault: true, not_built: true, connections_off: true,
}
const GUARDRAILS: { [K in Guardrail]: true } = { money: true, customer: true, destructive: true, access: true, bulk: true, count: true, unreviewed: true, browser: true }
const OPERATION_SET: { [K in WriteOperationKey]: true } = {
  'shopify.order.tag_add': true, 'slack.channel.post': true, 'shopify.order.tag_remove': true, 'shopify.draft_order.create': true,
  'shopify.inventory.restock': true, 'shopify.inventory.reduce': true, 'shopify.refund.create': true,
}
const EFFECT_FLAGS: { [K in keyof Effects]: true } = { money: true, customer: true, destructive: true, access: true, unreviewed: true }
const CONNECTORS: { [K in OperationConnector]: true } = { shopify: true, slack: true, mcp: true }
const ACCOUNT_CONNECTORS: { [K in AccountConnector]: true } = { shopify: true, slack: true }

const members = (set: Record<string, true>) => Object.keys(set).sort()
const sorted = (list: Iterable<string>) => [...list].sort()

describe('HubErrorCode (failure 1)', () => {
  it("every list of the hub's codes names each code once", () => {
    const all = members(HUB_CODES)
    expect(sorted(HubErrorCodeSchema.options)).toEqual(all)
    expect(sorted(HUB_ERROR_CODES)).toEqual(all)
    expect(new Set(HUB_ERROR_CODES).size).toBe(HUB_ERROR_CODES.length)
    expect(sorted(ConnectOutcomeSchema.options.filter(o => o !== 'ok'))).toEqual(all)
    expect(sorted(ActionFailCodeSchema.options)).toEqual(all)
    // The hub's own text table (hub/index/errors.ts) is checked against its schema in hub/index/schemas.test.ts.
  })
})

describe('Guardrail (failure 2)', () => {
  it('the schema names each guardrail', () => {
    expect(sorted(GuardrailSchema.options)).toEqual(members(GUARDRAILS))
  })
  it('the audit log says each guardrail in words, never its key', () => {
    for (const guardrail of GuardrailSchema.options) {
      const t = auditText({ action: 'action.requested', actionId: 'ac_AAAAAAAAAAAAAAAAAAAAAA', operation: 'shopify.order.tag_add', verdict: 'exact', guardrail, origin: 'chat', records: 1, units: 1 }, () => null)
      expect(t.detail, guardrail).toMatch(/needs an exact approval, \S+ \S+/)
      expect(t.detail, guardrail).not.toMatch(new RegExp(`, ${guardrail}$`))
    }
  })
})

describe('WriteOperationKey (failure 3)', () => {
  it('every written-out list and table names each operation', () => {
    const all = members(OPERATION_SET)
    expect(sorted(WRITE_OPERATIONS)).toEqual(all)
    expect(sorted(WriteOperationKeySchema.options)).toEqual(all)
    expect(sorted(WriteOperationArgSchema.options)).toEqual(all)
    expect(sorted(Object.keys(OPERATIONS))).toEqual(all)
    expect(sorted(OPERATION_KEYS)).toEqual(all)
    expect(sorted(Object.keys(OPERATION_TITLE))).toEqual(all)
    expect(sorted(Object.keys(OPERATION_LIMITS))).toEqual(all)
    expect(sorted(Object.keys(OPERATION_WORDS))).toEqual(all)
  })
})

describe('Effects (failure 4)', () => {
  it('each effect flag names its guardrail, in decide and on the ceiling screen', () => {
    const all = members(EFFECT_FLAGS)
    expect(sorted(EFFECT_GUARDRAILS)).toEqual(all)
    expect(sorted(CEILING_GUARDRAILS)).toEqual(all)
    for (const flag of all) expect(GuardrailSchema.options as readonly string[], flag).toContain(flag)
  })
  it("every operation's effects hold each flag, and no compiled operation is unreviewed", () => {
    for (const k of OPERATION_KEYS) {
      expect(sorted(Object.keys(OPERATIONS[k].effects)), k).toEqual(members(EFFECT_FLAGS))
      expect(OPERATIONS[k].effects.unreviewed, k).toBe(false)
    }
  })
})

describe('Connectors (failure 5)', () => {
  it("the ceiling screen names each connector's tool", () => {
    expect(sorted(Object.keys(CEILING_TOOL))).toEqual(members(CONNECTORS))
    for (const c of members(CONNECTORS)) expect(CEILING_TOOL[c as OperationConnector], c).toMatch(/^[A-Z]/)
  })
  it('each account connector has its account id, and the audit log names each by its label', () => {
    expect(sorted(Object.keys(ACCOUNT_IDS))).toEqual(members(ACCOUNT_CONNECTORS))
    for (const c of members(ACCOUNT_CONNECTORS)) {
      const accountId = ACCOUNT_IDS[c as AccountConnector]
      expect(auditText({ action: 'tools.pause', accountId, paused: true }, () => null).detail, c).not.toContain(accountId)
    }
    expect(auditText({ action: 'tools.pause', accountId: 'mcp:helpdesk', paused: true }, () => null).detail).toBe('Connected tool helpdesk')
  })
  it("every operation writes to a connector of the set", () => {
    for (const k of OPERATION_KEYS) expect(Object.hasOwn(CONNECTORS, OPERATIONS[k].connector), k).toBe(true)
  })
})
