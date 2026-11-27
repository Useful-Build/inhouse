// The egress's `actions` route (Stage 1 M2-D, N14): the agent's write tools, a third MCP server (`actions`, tools
// `mcp__actions__<tool>`) over Streamable HTTP (POST with a JSON answer only), on the grant's `mcp` route like `/hub/`.
// The runner gives a run this server only when its start asked for it (RunStart.actions: an operation is enabled for the
// brand, run-start.ts), and its proxy shuts `/actions/` for any other run (runner/src/proxy/server.ts).
//
// One `tools/call`:
//  1. The tool names an operation in the server's table (outbox/operations/), else it's refused.
//  2. Admission (N14): BrandAgent binds the call to an unused call of this tool, with this input's hash, by the main
//     agent in this live turn (do/brand-agent/invocations.ts). Else refused: a helper's call, a hand-made request, a call
//     after the turn was fenced. The JSON-RPC id and any id in the body are never trusted.
//  3. The outbox's `request` (the only way in): resolve, decide, a card or an approval under a live grant, or a refusal in
//     plain words that writes nothing. The asker is the chat's owner; a routine's run asks its creator (N15). The hub's
//     word on the accounts comes from BrandAgent (`hubAccounts`): the egress holds no hub binding but ReadGateway (P5).
//  4. BrandAgent adds the turn's `ask` part and the chat's `action.updated`.
//  5. The wait: a poll of the action row in D1 every 2 s, at most 120 s for an answer and 30 s more once approved. A turn
//     holds at most 3 waits; a job's or a routine's turn never waits. The answer is server words only: sent (with the safe
//     ref), "The person said no.", waiting, approved and being sent, or the failure in plain words. Never connector output.
//  6. Who tells the agent the result (`report`, do/brand-agent/asks.ts): this waiter only when it claimed `tool` while the
//     turn was live and saw the final state; otherwise a resume turn later.
// Specs read 2026-11-26: https://modelcontextprotocol.io/specification/2025-11-25/server/tools (`tools/list`,
// `tools/call`, `isError`), .../basic/transports (POST, 202 for a notification, `MCP-Protocol-Version`, `Origin`).
import { z } from 'zod'
import type { ActionState } from '../../shared/contract/actions.ts'
import { auditInputSha256 } from '../../shared/protocol/index.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { all, first, stmt } from '../db/sql.ts'
import { outboxFacts } from '../outbox/facts.ts'
import { operationEntry, operationForTool, OPERATIONS } from '../outbox/operations/index.ts'
import { openOutbox } from '../outbox/store.ts'
import { SEND_KIND, sendTaskId } from '../outbox/send-task.ts'
import { itemState } from '../outbox/card.ts'
import { FINAL_STATES } from '../outbox/sql.ts'
import type { OutboxActionRow, OutboxItemRow } from '../outbox/types.ts'
import type { Asker, Origin, WriteOperationKey } from '../permissions/types.ts'
import { MCP_PROTOCOL_VERSIONS } from '../mcp/server/index.ts'
import { ACTIONS_TOOL_PREFIX, APPROVAL_REQUEST_TOOL } from '../do/brand-agent/invocations.ts'
import type { ApprovalsWiring } from '../mcp/tools/approvals/index.ts'
import type { Admitted } from '../do/brand-agent/invocations.ts'
import { claimTool, d1Reports, waiterGaveUp, WAIT_AFTER_APPROVAL_MS, WAIT_MAX_MS, WAIT_POLL_MS } from '../do/brand-agent/asks.ts'
import type { BrandAgentRpc } from '../do/brand-agent/ports.ts'
import type { RunGrant } from '../do/brand-agent/tokens.ts'
import { readCapped } from './http.ts'

export const ACTIONS_PATH = '/actions/'
export const ACTIONS_MAX_BODY_BYTES = 64 * 1024
export const ACTIONS_SERVER_INFO = { name: 'actions', version: '1.0.0' } as const

const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602

type Id = string | number

// ---------- who asks (N15) ----------

export interface AskerOf { asker: Asker | null; origin: Origin }

/**
 * The asker and origin of an admitted call: a person's chat or job asks its owner, if still an active person; a
 * routine's run (`m_system`) asks the routine's creator, if still an active person, and a system routine has no one to
 * ask (`decide` refuses it, `no_one_to_ask`).
 */
export async function askerFor(db: D1Database, a: Pick<Admitted, 'ownerId' | 'chatId' | 'jobId'>): Promise<AskerOf> {
  const active = async (memberId: string): Promise<Asker | null> => {
    const m = await first<{ role: 'member' | 'admin' }>(db, stmt("SELECT role FROM members WHERE id = ? AND kind = 'person' AND status = 'active'", memberId))
    return m ? { memberId, role: m.role } : null
  }
  if (a.ownerId === SYSTEM_MEMBER_ID) {
    // By the run's chat (a routine's slot owns its chat): a resumed routine turn has another turn id, and the slot's
    // `turn_id` is written only once its submit is answered.
    const r = await first<{ origin: string; creator_id: string }>(db, stmt(
      'SELECT r.origin, r.creator_id FROM routine_slots s JOIN routines r ON r.id = s.routine_id WHERE s.chat_id = ? ORDER BY s.claimed_at_ms DESC LIMIT 1', a.chatId))
    return { asker: r && r.origin === 'team' ? await active(r.creator_id) : null, origin: 'routine' }
  }
  return { asker: await active(a.ownerId), origin: a.jobId !== null ? 'job' : 'chat' }
}

// ---------- the words ----------

const isFinal = (s: ActionState) => (FINAL_STATES as readonly string[]).includes(s)

/** What the agent reads about its action, in server words (N14 step 5). Never connector output: a sent ref is a safe ref. */
export const ACTION_WORDS = {
  sent: (ref: string | null) => (ref ? `Done. It went out: ${ref}.` : 'Done. It went out.'),
  denied: 'The person said no.',
  waiting: (name: string) => `Waiting for ${name}'s OK. It's in Approvals.`,
  approved: "Approved. It's being sent. You'll get the result.",
  failed: "It didn't go out. Nothing was changed.",
  needsCheck: (name: string) => `It isn't clear whether it went out, so ${name} was asked to check. Don't try it again.`,
  undone: (name: string) => `${name} undid it before it went out.`,
  withdrawn: 'It was withdrawn, so nothing went out.',
  expired: 'No one answered in 7 days, so nothing went out.',
  /** A job's or a routine's turn never waits. */
  laterNote: "You'll get the result when there is one.",
  /**
   * Another waiter holds this action's wait (the same call again). Its result comes from that wait, or, when the first
   * request was one the runner gave up on, as an automatic note from Inhouse (M2-G, from #444's review): both said.
   */
  alreadyWaiting: "This call is already being waited on, so this one doesn't wait. You'll get the result from that wait or, if it has ended, as an automatic note from Inhouse.",
  busyNote: "This turn is already waiting on other approvals, so this one isn't waited on. You'll get the result when there is one.",
  unknownTool: 'There is no such action tool, so nothing was asked or sent.',
  /** Stage 1 M3-B (N22): a batch that went out, its ref counting its items ("48 of 50 went out"). */
  batchSent: (ref: string | null) => (ref ? `Done: ${ref}.` : 'Done. It went out.'),
  /**
   * Stage 1 M3-B (N22): the call joined one card with other changes like it (collected). Its own item's state is what
   * the words say; the card's other items are other calls'.
   */
  collected: (name: string, others: number) =>
    `Waiting for ${name}'s OK. It's in Approvals on one card with ${others === 1 ? '1 other change' : `${others} other changes`} like it, so ${name} answers them together.`,
  notAdmitted: "That call couldn't be matched to this turn, so nothing was asked or sent.",
  unavailable: 'Actions are unavailable for a moment, so nothing was asked or sent. Try once more; if it fails again, tell the person.',
} as const

const refOf = (resultJson: string | null): string | null => {
  const ref = resultJson ? (JSON.parse(resultJson) as { ref?: unknown }).ref : undefined
  return typeof ref === 'string' && ref !== '' ? ref : null
}

function wordsFor(row: OutboxActionRow, name: string): string {
  switch (row.state) {
    case 'sent': return row.kind === 'batch' ? ACTION_WORDS.batchSent(refOf(row.result_json)) : ACTION_WORDS.sent(refOf(row.result_json))
    case 'denied': return ACTION_WORDS.denied
    case 'waiting': return ACTION_WORDS.waiting(name)
    case 'approved':
    case 'sending': return ACTION_WORDS.approved
    case 'failed': return ACTION_WORDS.failed
    case 'needs_check': return ACTION_WORDS.needsCheck(name)
    case 'undone': return ACTION_WORDS.undone(name)
    case 'withdrawn': return ACTION_WORDS.withdrawn
    case 'expired': return ACTION_WORDS.expired
  }
}

/** A collected call's words: its own item's state in server words. */
function itemWords(item: OutboxItemRow, batch: OutboxActionRow, name: string): string {
  const state = itemState(item, batch)
  if (state === 'waiting') return ACTION_WORDS.collected(name, Math.max(0, batch.items_n - 1))
  if (state === 'sent') return ACTION_WORDS.sent(refOf(item.result_json))
  return wordsFor({ ...batch, kind: 'single', state }, name)
}

// ---------- the route ----------

/** What the actions route works with; injected so tests drive it with fakes and a fake clock. */
export interface ActionsRouteDeps {
  db: D1Database
  /** BrandAgent: admission, the asks, the send's task, and the hub's word on the accounts (the egress holds no hub binding but ReadGateway). */
  rpc: Pick<BrandAgentRpc, 'admitAction' | 'askNoted' | 'beginAskWait' | 'endAskWait' | 'askTurnLive' | 'actionChanged' | 'poke' | 'hubAccounts'>
  now(): number
  sleep(ms: number): Promise<void>
  requestId(): string
  log(e: Record<string, unknown>): void
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } })
const rpcError = (id: Id | null, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id, error: { code, message } }, status)
const rpcResult = (id: Id, result: unknown) => json({ jsonrpc: '2.0', id, result })
const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v))
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A tool result: the words first, then the action's id and state as data. The CLI (2.1.328) hands the model a tool's
 * `structuredContent` in place of its text when both are given (#444's re-check, 714340c8), so the words go in it too
 * (`message`): the server's words are what the agent reads, on either client (M2-G).
 */
const toolAnswer = (text: string, data: Record<string, unknown>, isError = false) =>
  ({ content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data) }], structuredContent: { message: text, ...data }, ...(isError ? { isError: true } : {}) })
const refused = (code: string, text: string) => ({ content: [{ type: 'text', text }], structuredContent: { error: code, message: text }, isError: true })

/** The operations the brand has on (N2: none in a deployable build, so the list is empty). */
async function enabledOperations(db: D1Database): Promise<WriteOperationKey[]> {
  const rows = await all<{ operation: string }>(db, stmt('SELECT operation FROM permission_ceiling WHERE enabled = 1 ORDER BY operation'))
  return rows.map(r => r.operation).filter((k): k is WriteOperationKey => operationEntry(k) !== null)
}

/** `tools/list`: each enabled operation's tool, its strict input schema and its description. Writes, so not read only. */
async function toolList(db: D1Database) {
  return (await enabledOperations(db)).map(k => {
    const e = OPERATIONS[k]
    return {
      name: e.tool, description: e.description, inputSchema: z.toJSONSchema(e.args, { io: 'input' }),
      annotations: { readOnlyHint: false, destructiveHint: Object.values(e.effects).some(Boolean), idempotentHint: false, openWorldHint: true },
    }
  })
}

/** One MCP POST to `/actions/`, as the grant's run. */
export async function handleActions(request: Request, grant: RunGrant, d: ActionsRouteDeps): Promise<Response> {
  if (new URL(request.url).pathname !== ACTIONS_PATH) return json({ error: 'not_found' }, 404)
  if (request.method !== 'POST') return json({ error: 'method' }, 405, { Allow: 'POST' })
  if (request.headers.has('Origin')) return rpcError(null, INVALID_REQUEST, 'Origin not allowed', 403)
  const version = request.headers.get('MCP-Protocol-Version')
  if (version !== null && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) return rpcError(null, INVALID_REQUEST, 'Unsupported MCP-Protocol-Version', 400)
  const type = request.headers.get('Content-Type')?.split(';', 1)[0]!.trim().toLowerCase()
  if (type !== 'application/json') return rpcError(null, INVALID_REQUEST, 'Content-Type must be application/json', 415)
  const bytes = await readCapped(request, ACTIONS_MAX_BODY_BYTES)
  if (bytes === null) return rpcError(null, INVALID_REQUEST, 'Body too large', 413)
  let message: unknown
  try {
    message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error', 400)
  }
  if (Array.isArray(message)) return rpcError(null, INVALID_REQUEST, 'Batches are not supported: send one message per POST', 400)
  if (!isObject(message) || message.jsonrpc !== '2.0') return rpcError(null, INVALID_REQUEST, 'Invalid Request', 400)
  if (typeof message.method !== 'string') {
    if ('id' in message && ('result' in message || 'error' in message)) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } })
    return rpcError(null, INVALID_REQUEST, 'Invalid Request', 400)
  }
  if (!('id' in message)) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  if (!isId(message.id)) return rpcError(null, INVALID_REQUEST, 'Invalid Request: id must be a string or an integer', 400)
  const id = message.id
  const params = message.params
  if (params !== undefined && !isObject(params)) return rpcError(id, INVALID_PARAMS, 'params must be an object')

  switch (message.method) {
    case 'initialize': {
      const asked = params?.protocolVersion
      if (typeof asked !== 'string') return rpcError(id, INVALID_PARAMS, 'initialize needs params.protocolVersion')
      const agreed = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0]
      return rpcResult(id, { protocolVersion: agreed, capabilities: { tools: { listChanged: false } }, serverInfo: ACTIONS_SERVER_INFO })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: await toolList(d.db) })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (typeof name !== 'string' || !isObject(args)) {
        return rpcError(id, INVALID_PARAMS, 'tools/call needs params.name (a string) and params.arguments (an object, if given)')
      }
      return rpcResult(id, await callAction(grant, name, args, d))
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, 'Method not found')
  }
}

/** One write tool call (steps 1 to 6 above). */
export async function callAction(grant: RunGrant, name: string, args: Record<string, unknown>, d: ActionsRouteDeps) {
  const operation = operationForTool(name)
  if (!operation) return refused('unknown_operation', ACTION_WORDS.unknownTool)
  const admitted = await d.rpc.admitAction(grant.turnId, `${ACTIONS_TOOL_PREFIX}${name}`, await auditInputSha256(args))
  if ('refused' in admitted) {
    d.log({ event: 'actions_not_admitted', turnId: grant.turnId, why: admitted.refused })
    return refused('not_admitted', ACTION_WORDS.notAdmitted)
  }
  // The admitted turn is the grant's own (the token is the turn's); anything else is a bug, never a way in.
  if (admitted.turnId !== grant.turnId || admitted.chatId !== grant.chatId) throw new Error('actions: admission answered another turn')
  // A replay (the same call again, every matching invocation used) only ever answers that call's own action. One whose
  // first try was refused wrote nothing, so the replay is refused too, whatever the rules say now.
  if (admitted.replay && !(await invocationRow(d.db, admitted.chatId, admitted.toolUseId))) {
    d.log({ event: 'actions_not_admitted', turnId: grant.turnId, why: 'replay_without_action' })
    return refused('not_admitted', ACTION_WORDS.notAdmitted)
  }
  const requestId = d.requestId()
  const nowMs = d.now()
  const who = await askerFor(d.db, admitted)
  const port = openOutbox({
    db: d.db, requestId, now: d.now,
    facts: outboxFacts({ db: d.db, hubAccounts: () => d.rpc.hubAccounts() }),
    schedule: (actionId, atMs) => d.rpc.poke({ kind: SEND_KIND, id: sendTaskId(actionId), dueAtMs: atMs }),
  })
  const r = await port.request(
    { asker: who.asker, origin: who.origin, chatId: admitted.chatId, nowMs, invocation: { runId: admitted.runId, turnId: admitted.turnId, toolUseId: admitted.toolUseId }, jobId: admitted.jobId },
    { operation, args },
    { mode: 'tool' },
  )
  if (r.outcome === 'refused') return refused(r.reason, r.text)
  if (r.outcome === 'collected') {
    // Stage 1 M3-B (N22): the call joined a batch other calls share, so it has no action of its own to wait on. It's
    // answered at once from its own item; the batch's one report (a resume turn once it ends) tells the agent the rest.
    const batch = r.action
    await d.rpc.askNoted(admitted.turnId, batch.id)
    await waiterGaveUp(d1Reports(d.db), batch.id, false)
    await d.rpc.actionChanged(batch.id)
    const name = await approverName(d.db, batch.approver)
    const state = itemState(r.item, batch)
    const final = isFinal(state)
    return toolAnswer(
      `${itemWords(r.item, batch, name)}${final ? '' : ` ${ACTION_WORDS.laterNote}`} (approval_id: ${batch.id}, item ${r.item.n})`,
      { approval_id: batch.id, item: r.item.n, status: state },
    )
  }
  const actionId = r.action.id
  await d.rpc.askNoted(admitted.turnId, actionId)
  const approver = await approverName(d.db, r.action.approver)
  const answerFor = (row: OutboxActionRow, note?: string) =>
    toolAnswer(`${wordsFor(row, approver)}${note ? ` ${note}` : ''} (approval_id: ${row.id})`, { approval_id: row.id, status: row.state })
  const store = d1Reports(d.db)

  if (isFinal(r.action.state)) return answerFor(r.action)
  if (who.origin !== 'chat') {
    // A job's or a routine's turn never waits (N14): the result comes later.
    await waiterGaveUp(store, actionId, false)
    await d.rpc.actionChanged(actionId)
    return answerFor(r.action, ACTION_WORDS.laterNote)
  }
  const begun = await d.rpc.beginAskWait(admitted.turnId, actionId)
  if (!begun.wait && begun.why === 'already_waiting') {
    // Another waiter on this action (the same call again) owns its wait and its report: say where it stands, change nothing.
    const now = await first<OutboxActionRow>(d.db, stmt('SELECT * FROM outbox_actions WHERE id = ?', actionId))
    return answerFor(now ?? r.action, ACTION_WORDS.alreadyWaiting)
  }
  if (!begun.wait) {
    await waiterGaveUp(store, actionId, false)
    await d.rpc.actionChanged(actionId)
    return answerFor(r.action, begun.why === 'busy' ? ACTION_WORDS.busyNote : ACTION_WORDS.laterNote)
  }
  let claimed = false
  let delivered = false
  try {
    claimed = await claimTool(store, actionId, () => d.rpc.askTurnLive(admitted.turnId))
    if (!claimed) {
      // Another waiter or a resume owns the report, or the turn died: say where it stands now, without waiting.
      const now = await first<OutboxActionRow>(d.db, stmt('SELECT * FROM outbox_actions WHERE id = ?', actionId))
      return answerFor(now ?? r.action)
    }
    const row = await waitFor(d, actionId)
    if (isFinal(row.state)) {
      delivered = true
      return answerFor(row)
    }
    await waiterGaveUp(store, actionId, true)
    return answerFor(row)
  } finally {
    await d.rpc.endAskWait(actionId, delivered)
  }
}

/** The poll (N14 step 4): every 2 s, at most 120 s for an answer, then 30 s more once approved. The last row read. */
async function waitFor(d: ActionsRouteDeps, actionId: string): Promise<OutboxActionRow> {
  const start = d.now()
  let approvedAt: number | null = null
  for (;;) {
    const row = await first<OutboxActionRow>(d.db, stmt('SELECT * FROM outbox_actions WHERE id = ?', actionId))
    if (!row) throw new Error(`actions: the action ${actionId} is gone`)
    if (isFinal(row.state)) return row
    const now = d.now()
    if (row.state === 'approved' || row.state === 'sending') approvedAt ??= now
    else approvedAt = null
    const deadline = approvedAt !== null ? Math.max(start + WAIT_MAX_MS, approvedAt + WAIT_AFTER_APPROVAL_MS) : start + WAIT_MAX_MS
    if (now >= deadline) return row
    await d.sleep(Math.min(WAIT_POLL_MS, Math.max(0, deadline - now)))
  }
}

/**
 * The action an invocation made, if any (the outbox's `(chat_id, tool_use_id)` key), or (Stage 1 M3-B) the batch its
 * collected item sits in now.
 */
const invocationRow = async (db: D1Database, chatId: string, toolUseId: string) =>
  (await first<{ id: string }>(db, stmt('SELECT id FROM outbox_actions WHERE chat_id = ? AND tool_use_id = ?', chatId, toolUseId)))
    ?? first<{ id: string }>(db, stmt('SELECT action_id AS id FROM outbox_items WHERE chat_id = ? AND tool_use_id = ?', chatId, toolUseId))

/** The approver's name as the agent reads it ("Dana"), or "the person". */
async function approverName(db: D1Database, memberId: string): Promise<string> {
  const m = await first<{ name: string | null }>(db, stmt('SELECT name FROM members WHERE id = ?', memberId))
  const name = m?.name?.trim()
  return name ? name : 'the person'
}

/** The approval tools' wiring (mcp/tools/approvals, M2-E's seam): the hub's accounts, N14's admission, the routine's asker. */
export function approvalsWiring(d: ActionsRouteDeps): ApprovalsWiring {
  return {
    hubAccounts: () => d.rpc.hubAccounts(),
    async admit(scope, input) {
      const a = await d.rpc.admitAction(scope.turnId, APPROVAL_REQUEST_TOOL, await auditInputSha256(input))
      if ('refused' in a) {
        d.log({ event: 'actions_not_admitted', turnId: scope.turnId, tool: 'approval_request', why: a.refused })
        return null
      }
      if (a.turnId !== scope.turnId || a.chatId !== scope.chatId) throw new Error('approval_request: admission answered another turn')
      if (a.replay && !(await invocationRow(d.db, a.chatId, a.toolUseId))) {
        d.log({ event: 'actions_not_admitted', turnId: scope.turnId, tool: 'approval_request', why: 'replay_without_action' })
        return null
      }
      return { toolUseId: a.toolUseId, jobId: a.jobId }
    },
    routineAsker: async scope => (await askerFor(d.db, { ownerId: SYSTEM_MEMBER_ID, chatId: scope.chatId, jobId: null })).asker,
    noted: (scope, actionId) => d.rpc.askNoted(scope.turnId, actionId),
  }
}
