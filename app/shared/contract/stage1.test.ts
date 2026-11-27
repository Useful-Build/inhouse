// Stage 1's frozen contracts (W0-A): actions.ts, permissions.ts, questions.ts, jobs.ts and their additions to runs.ts and
// chat.ts. Every expected value is a literal written here from the plan's notes (N3, N9, N11, N18), never read back from
// the code under test. Ways it can fail, written down first:
//  1. a list drifts from the plan (an action state, a guardrail, a job outcome, a turn source or a cancel reason added,
//     dropped or renamed);
//  2. an id of another kind (a support grant's `g_`, an Activity line's `a_`, a turn id) passes as an action,
//     permission, question or job id;
//  3. an answer input takes an unknown key, a choice outside the four, or no `ifRev` (or 0: revs start at 1); a resolve
//     takes an outcome other than sent or failed;
//  4. a question with fewer than 2 or more than 4 options, or one option twice, parses;
//  5. a new chat event (`job.*`, `action.updated`) or the `ask` part doesn't parse, or `turn.queued` refuses a frame with
//     no `source` (every frame sent before Stage 1).
import { describe, expect, it } from 'vitest'
import {
  ActionCardSchema, ActionChoiceSchema, ActionFilterSchema, ActionIdSchema, ActionStateSchema, AnswerActionInputSchema, AnswerQuestionInputSchema,
  CancelWhySchema, ChatEventSchema, ChatJobSchema, GuardrailSchema, JobIdSchema, JobOutcomeSchema, JobStateSchema, MessagePartSchema,
  PermissionIdSchema, PermissionSchema, QuestionIdSchema, QuestionSchema, QuestionStateSchema, RemovePermissionInputSchema,
  ResolveActionInputSchema, TurnSourceSchema, UndoActionInputSchema,
} from './index.ts'

const R = '0123456789abcdefABCDEF'
const at = { iso: '2026-11-26T10:00:00.000Z', ms: Date.parse('2026-11-26T10:00:00.000Z') }
const later = { iso: '2026-11-26T18:00:00.000Z', ms: Date.parse('2026-11-26T18:00:00.000Z') }
const turnId = `t_${R}`

describe('lists (failure 1)', () => {
  it('are exactly the plan\'s', () => {
    expect(ActionStateSchema.options).toEqual(['waiting', 'approved', 'sending', 'sent', 'failed', 'needs_check', 'undone', 'denied', 'withdrawn', 'expired'])
    expect(GuardrailSchema.options).toEqual(['money', 'customer', 'destructive', 'access', 'bulk', 'count', 'unreviewed', 'browser'])
    expect(ActionChoiceSchema.options).toEqual(['once', 'always', 'approve', 'deny'])
    expect(JobStateSchema.options).toEqual(['running', 'waiting', 'ended'])
    expect(JobOutcomeSchema.options).toEqual(['done', 'failed', 'budget', 'cancelled', 'time', 'stuck', 'taken_over'])
    expect(QuestionStateSchema.options).toEqual(['open', 'answered', 'expired', 'closed'])
    expect(TurnSourceSchema.options).toEqual(['job', 'action', 'question'])
    expect([...CancelWhySchema.options].sort()).toEqual(['cap_reached', 'deleted', 'job_budget', 'paused', 'pool_full', 'removed', 'session_unusable'])
  })
})

describe('ids (failure 2)', () => {
  it('take only their own prefix and 128 random bits', () => {
    const cases: [typeof ActionIdSchema, string][] = [[ActionIdSchema, 'ac_'], [PermissionIdSchema, 'pg_'], [QuestionIdSchema, 'q_'], [JobIdSchema, 'j_']]
    for (const [schema, prefix] of cases) {
      expect(schema.safeParse(`${prefix}${R}`).success, prefix).toBe(true)
      // `a_` is an Activity line's id, `g_` a support grant's.
      for (const bad of [`${prefix}${R}x`, `${prefix}${R.slice(1)}`, `g_${R}`, `a_${R}`, turnId, `${prefix}${R.slice(1)}.`, ''])
        expect(schema.safeParse(bad).success, `${prefix} ${bad}`).toBe(false)
    }
  })
})

describe('inputs (failure 3)', () => {
  it('answer, undo, resolve and remove take exactly their keys', () => {
    expect(AnswerActionInputSchema.safeParse({ choice: 'once', ifRev: 1 }).success).toBe(true)
    expect(AnswerActionInputSchema.safeParse({ choice: 'allow', ifRev: 1 }).success).toBe(false)
    expect(AnswerActionInputSchema.safeParse({ choice: 'once' }).success).toBe(false)
    // Revs start at 1, so an ifRev of 0 can never match.
    expect(AnswerActionInputSchema.safeParse({ choice: 'once', ifRev: 0 }).success).toBe(false)
    expect(UndoActionInputSchema.safeParse({ ifRev: 0 }).success).toBe(false)
    expect(ResolveActionInputSchema.safeParse({ outcome: 'sent', ifRev: 0 }).success).toBe(false)
    expect(RemovePermissionInputSchema.safeParse({ ifRev: 0 }).success).toBe(false)
    expect(AnswerActionInputSchema.safeParse({ choice: 'once', ifRev: 1, grant: true }).success).toBe(false)
    expect(UndoActionInputSchema.safeParse({ ifRev: 2 }).success).toBe(true)
    expect(UndoActionInputSchema.safeParse({}).success).toBe(false)
    expect(ResolveActionInputSchema.safeParse({ outcome: 'sent', ifRev: 3 }).success).toBe(true)
    expect(ResolveActionInputSchema.safeParse({ outcome: 'failed', ifRev: 3 }).success).toBe(true)
    expect(ResolveActionInputSchema.safeParse({ outcome: 'unknown', ifRev: 3 }).success).toBe(false)
    expect(RemovePermissionInputSchema.safeParse({ ifRev: 1 }).success).toBe(true)
    expect(RemovePermissionInputSchema.safeParse({ ifRev: 1, all: true }).success).toBe(false)
    expect(ActionFilterSchema.safeParse({}).success).toBe(true)
    expect(ActionFilterSchema.safeParse({ states: ['waiting', 'needs_check'] }).success).toBe(true)
    expect(ActionFilterSchema.safeParse({ states: [] }).success).toBe(false)
    expect(ActionFilterSchema.safeParse({ states: ['pending'] }).success).toBe(false)
    expect(AnswerQuestionInputSchema.safeParse({ choice: 'Ship today' }).success).toBe(true)
    expect(AnswerQuestionInputSchema.safeParse({ choice: '' }).success).toBe(false)
  })
})

describe('records', () => {
  const card = {
    id: `ac_${R}`, rev: 1, kind: 'ask', state: 'waiting', title: 'Tag order #1001', lines: ['Adds the tag vip'],
    tool: { accountId: 'shopify:store', label: 'Shopify (Store A)' }, records: 1, reachesCustomer: false, reversible: true,
    chatId: 'chat-1', askedBy: 'm_owner', askedAt: at, serverNow: at,
    can: { allowOnce: true, alwaysAllow: true, approve: false, deny: true, undo: false, resolve: false }, nudgeAlways: false, approverKind: 'person',
  }
  it('an action card parses, with its optional fields or without', () => {
    expect(ActionCardSchema.safeParse(card).success).toBe(true)
    expect(ActionCardSchema.safeParse({ ...card, kind: 'exact', guardrail: 'bulk', chatId: null, sendAt: later, result: 'Sent.', lapsed: 'Paused.' }).success).toBe(true)
    expect(ActionCardSchema.safeParse({ ...card, guardrail: 'cost' }).success).toBe(false)
    expect(ActionCardSchema.safeParse({ ...card, kind: 'run' }).success).toBe(false)
  })

  it('a permission parses for a member or the brand', () => {
    const p = {
      id: `pg_${R}`, rev: 1, holder: { kind: 'member', memberId: 'm_owner' }, operation: 'shopify.order.tag_add', title: 'Add tags to orders',
      tool: { accountId: 'shopify:store', label: 'Shopify (Store A)' }, scope: 'Store A', perDay: 50, limits: { perDay: 50, unitsMax: 1, unitsLabel: 'orders', effectivePerDay: 50 }, grantedBy: 'm_owner', grantedAt: at, can: { remove: true },
    }
    expect(PermissionSchema.safeParse(p).success).toBe(true)
    expect(PermissionSchema.safeParse({ ...p, holder: { kind: 'brand' } }).success).toBe(true)
    expect(PermissionSchema.safeParse({ ...p, holder: { kind: 'team' } }).success).toBe(false)
    expect(PermissionSchema.safeParse({ ...p, perDay: 0 }).success).toBe(false)
  })

  it('a question takes 2 to 4 options (failure 4)', () => {
    const q = { id: `q_${R}`, state: 'open', question: 'Ship today?', options: ['Yes', 'No'], chatId: null, askedAt: at, expiresAt: later, answer: null, answeredBy: null, answeredAt: null }
    expect(QuestionSchema.safeParse(q).success).toBe(true)
    expect(QuestionSchema.safeParse({ ...q, options: ['a', 'b', 'c', 'd'] }).success).toBe(true)
    expect(QuestionSchema.safeParse({ ...q, options: ['Yes'] }).success).toBe(false)
    expect(QuestionSchema.safeParse({ ...q, options: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(false)
    // A choice's text names one option, so no option is listed twice.
    expect(QuestionSchema.safeParse({ ...q, options: ['Yes', 'No', 'Yes'] }).success).toBe(false)
  })

  it("a chat's job is a job or null", () => {
    const job = {
      jobId: `j_${R}`, chatId: 'chat-1', rootTurnId: turnId, state: 'running', outcome: null, startedAt: at, deadlineAt: later, endedAt: null,
      progress: { label: 'Reading orders', helpers: 2 }, cost: null,
    }
    expect(ChatJobSchema.safeParse({ job }).success).toBe(true)
    expect(ChatJobSchema.safeParse({ job: null }).success).toBe(true)
    expect(ChatJobSchema.safeParse({ job: { ...job, state: 'ended', outcome: 'budget', endedAt: later, cost: { minor: 2500, currency: 'USD' } } }).success).toBe(true)
    expect(ChatJobSchema.safeParse({ job: { ...job, progress: { label: 'x', helpers: -1 } } }).success).toBe(false)
  })
})

describe('chat events and the ask part (failure 5)', () => {
  const jobId = `j_${R}`
  it('parse', () => {
    const ok = (e: unknown) => ChatEventSchema.safeParse(e).success
    expect(ok({ type: 'job.started', jobId, rootTurnId: turnId })).toBe(true)
    expect(ok({ type: 'job.progress', jobId, label: 'Two helpers are reading', helpers: 2 })).toBe(true)
    expect(ok({ type: 'job.ended', jobId, outcome: 'time', durationMs: 28_800_000, cost: { minor: 1200, currency: 'USD' } })).toBe(true)
    expect(ok({ type: 'job.ended', jobId, outcome: 'paused', durationMs: 1, cost: { minor: 0, currency: 'USD' } })).toBe(false)
    expect(ok({ type: 'action.updated', actionId: `ac_${R}`, rev: 2, state: 'approved' })).toBe(true)
    expect(ok({ type: 'action.updated', actionId: `ac_${R}`, rev: 0, state: 'approved' })).toBe(false)
    expect(ok({ type: 'turn.cancelled', turnId, why: 'job_budget' })).toBe(true)
    expect(MessagePartSchema.safeParse({ type: 'ask', actionId: `ac_${R}` }).success).toBe(true)
    expect(MessagePartSchema.safeParse({ type: 'ask', actionId: 'x' }).success).toBe(false)
  })

  it('turn.queued takes a source, and still parses without one', () => {
    const queued = { type: 'turn.queued', turnId, messageId: `${turnId}.u`, text: 'Carry on', attachments: [], priority: 'next', by: 'm_owner' }
    expect(ChatEventSchema.safeParse(queued).success).toBe(true)
    for (const source of ['job', 'action', 'question']) expect(ChatEventSchema.safeParse({ ...queued, source }).success, source).toBe(true)
    expect(ChatEventSchema.safeParse({ ...queued, source: 'routine' }).success).toBe(false)
  })
})
