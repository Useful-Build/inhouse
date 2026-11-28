// The product target's memory door. No route makes or approves a memory fact (a person's saved fact counts at once, a team
// fact waits for an admin, and only the agent's tools write either), so the harness seeds each case's memory, and reads what a
// chat changed, through the eval deployment's own D1. Three rules bind it (A8, 2026-11-21):
//   (a) it is made only after the eval-brand check passed (createDoor is called by the product session setup after it);
//   (b) it refuses any database but the eval deployment's: the name must be exactly scripts/sandbox/names.mjs's
//       evalNames().d1 (`inhouse-sbx-eval-db`, pinned by a test against that file; a PR's test deployment runs the scripted
//       model and is never a paid eval's target), and CF_SANDBOX_ACCOUNT_ID must be set;
//   (c) its credentials come from the environment (wrangler reads CLOUDFLARE_API_TOKEN itself) and are never logged: wrangler's
//       stderr is dropped, and a failure names only the command's exit status.
// Statements are built here from invented case text with every string literal quoted; ids are checked against a pattern.
// The morning-check set (evals/morning-check/run.mjs --target) has its own database rule, assertMorningCheckDatabase:
// EVAL_DB for its graded run, or a PR's test deployment (`inhouse-sbx-pr<N>-db`) for its scripted proof; never the
// candidate's. createDoor's own runner keeps (b).
// One runner per eval deployment (#308 review): the product target and the morning-check graded run each take the eval
// lease (a `settings` row, owner `test-control`, key `eval:lease`, holding the run's tag and an expiry) before any spend,
// and give it back on exit. The product target also refuses to start while a test shop override (`hub:shop`) is set. The
// lease's clock is D1's own (julianday('now'), D1_NOW_MS), never a runner's, so two runners' clocks can't disagree about expiry.
// Break-glass, only once no run is going: a dead run's lease lapses after EVAL_LEASE_TTL_MS, or is removed at once with
//   npx wrangler d1 execute inhouse-sbx-eval-db --remote --config <the sandbox config> --command "DELETE FROM settings WHERE owner = 'test-control' AND key = 'eval:lease'"
import { PLANTED_NAME_LIST } from '../injection/names.ts'
import { execFileSync, spawn as spawnChild } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { MAX_JOB_BUDGET_USD, MIN_JOB_BUDGET_USD, capOk, parseHostlist } from '../../shared/contract/settings-table.ts'
import { TEST_SHOP_KEY, TEST_SHOP_OWNER } from '../../server/egress/test-shop.ts'
import { D1_NOW_MS, DoorRefusal, sqlString } from './sql.ts'
import type { RunSql } from './sql.ts'
import { TransientDoorError, withRetries, type RetryOptions } from './retry.ts'

// Stage 1 M3-R: these live in ./sql.ts (no Node import, for the write door); re-exported so every caller is unchanged.
export { D1_NOW_MS, DoorRefusal, sqlString }
export type { RunSql }

/** The eval deployment's database: scripts/sandbox/names.mjs's evalNames().d1 (a test pins the two equal). */
export const EVAL_DB = 'inhouse-sbx-eval-db'
/**
 * A PR's test deployment's database: scripts/sandbox/names.mjs PER_PR with the `-db` word only (perPrNames(N).d1; a test
 * pins the two). The morning-check set's scripted proof runs there.
 */
export const PER_PR_DB = /^inhouse-sbx-pr([1-9][0-9]{0,5})-db$/
/** How long an eval lease holds unless renewed: each case renews it, so only a run that died leaves one to expire. */
export const EVAL_LEASE_TTL_MS = 2 * 60 * 60_000
const LEASE_KEY = 'eval:lease'
const LEASE_TAG = /^[A-Za-z0-9._:-]{1,100}$/
const MEMORY_ID = /^mem_[A-Za-z0-9_-]{22}$/
const MEMBER_ID = /^[A-Za-z0-9_-]{1,80}$/

export interface MemoryRow {
  id: string
  scope: 'brand' | 'person'
  ownerId: string | null
  text: string
  status: 'active' | 'waiting' | 'forgotten'
  rev: number
}
export interface NewMemory {
  id: string
  scope: 'brand' | 'person'
  ownerId: string | null
  text: string
}

export interface MemoryDoor {
  /** Whether the deployment's D1 holds a chat with this id: the proof that the database is the one the API answers from. */
  hasChat(id: string): Promise<boolean>
  /** Every fact in the brand's memory, whatever its status. */
  rows(): Promise<MemoryRow[]>
  /** Puts facts in, active (the case's premise is that the agent knows them). */
  insert(facts: NewMemory[]): Promise<void>
  /**
   * Empties the brand's memory and its requests to the Inhouse team, and deletes every team routine: the eval brand holds
   * nothing a case-repeat should carry over (Stage 1 M2-G: T14's repeat 1 left an open request that repeats 2 and 3 found;
   * T11 failed 3/3 because routines an earlier run made were already on the brand). Routines go the product's own way, a
   * soft delete (store.ts deleteRoutine: `deleted_at_ms` set, so no list, tick or team cap counts them; their slots keep
   * their rows), and are read back: a team routine still live is a DoorRefusal. System routines (the morning check) stay.
   */
  clear(): Promise<void>
  /**
   * Puts in one waiting approval of `askedBy` in `chatId` (Stage 1 M2-G: T15, T16), as the outbox would hold a card made
   * through `approval_request` for a tag on an order: id, chat, person, title and line checked to their literal-safe shapes.
   */
  insertApproval(a: NewApproval): Promise<void>
  /** Deletes the approvals with these ids (the ones a case-repeat seeded). */
  deleteApprovals(ids: string[]): Promise<void>
  /** Sets the brand's monthly Spending cap (`s:cap`, its saved text, e.g. "$50"): the eval brand's $50 (O2 note). */
  setSpendingCap(cap: string): Promise<void>
  /**
   * Sets the brand's job budget (`s:job_cap`, its saved text, e.g. "$1"; Stage 1 M1-P): a case whose turn hits a limit
   * carries on as a job behind the harness, so the run pins the job budget low and no case spends past it that way.
   */
  setJobCap(cap: string): Promise<void>
  /**
   * Sets the brand's WebFetch list (`t:webfetch`, hosts one per line) to an exfiltration case's hosts, so the hook refuses
   * exactly what the grader calls unlisted (rec 6); null deletes it (the default: no host, P8a S).
   */
  setWebfetchHosts(hosts: string[] | null): Promise<void>
  /**
   * Turns the brand's web search (`t:websearch`, P8a S) on for a web-tool case (JSON true), or off by deleting it (the
   * default). Anything but a boolean is refused.
   */
  setWebSearch(on: boolean): Promise<void>
  /**
   * Invites a case person: a `person` row, role member, status invited, no subject, the email given. The product binds it
   * to the first sign-in with that email (server/db/members.ts resolvePerson, path 2, with its own audit line).
   */
  invitePerson(p: { id: string; email: string; name: string }): Promise<void>
  /** M3-E (#566): an active teammate (no sign-in) with an eval address and a planted name; and its removal. */
  addTeammate(p: { id: string; email: string; name: string }): Promise<void>
  removeTeammate(id: string): Promise<void>
  /**
   * Sets the brand's Default model (`g:mode`, a picker label such as "Fast"), which a routine's turn runs on
   * (server/routines/brand.ts submitSettings), and reads it back.
   */
  setDefaultModel(label: string): Promise<void>
  /**
   * Takes (or renews) the eval lease for `tag` until D1's now + EVAL_LEASE_TTL_MS, in one conditional upsert on D1's clock:
   * it goes through only when no row is there, the row's lease has expired, or it is this tag's. Read back: another tag
   * there is a DoorRefusal naming it and its expiry.
   */
  takeLease(tag: string): Promise<void>
  /** Gives the lease back if this tag holds it (another's is left alone), and reads back that this tag holds none. */
  releaseLease(tag: string): Promise<void>
  /** The test shop override's host (`hub:shop`, the morning-check door's row), or null when none is set. */
  testShop(): Promise<string | null>
}

export const newMemoryId = (): string => `mem_${randomBytes(16).toString('base64url')}`
/** An outbox action id (`ac_` and 128 random bits), the form the approval tools take. */
export const newActionId = (): string => `ac_${randomBytes(16).toString('base64url')}`
const ACTION_ID = /^ac_[A-Za-z0-9_-]{22}$/
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/
const CARD_TEXT = /^[A-Za-z0-9 :.,'-]{1,80}$/

export interface NewApproval { id: string; chatId: string; askedBy: string; title: string; line: string }

/** The morning-check set's rule: EVAL_DB (its graded run) or a PR's test database (its scripted proof), in the sandbox account. */
export function assertMorningCheckDatabase(name: string | undefined, env: Record<string, string | undefined>): string {
  if (!name) throw new DoorRefusal('refusing: INHOUSE_EVAL_D1_NAME is not set (the deployment\'s D1 database)')
  if (name !== EVAL_DB && !PER_PR_DB.test(name)) throw new DoorRefusal(`refusing: ${JSON.stringify(name)} is neither the eval deployment's database (${EVAL_DB}) nor a PR's test database (inhouse-sbx-pr<N>-db)`)
  if (!env.CF_SANDBOX_ACCOUNT_ID) throw new DoorRefusal('refusing: CF_SANDBOX_ACCOUNT_ID is not set, so the target is not known to be the sandbox account')
  return name
}

export function assertSandboxDatabase(name: string | undefined, env: Record<string, string | undefined>): string {
  if (!name) throw new DoorRefusal('refusing: INHOUSE_EVAL_D1_NAME is not set (the eval deployment\'s D1 database)')
  if (name !== EVAL_DB) throw new DoorRefusal(`refusing: ${JSON.stringify(name)} is not the eval deployment's database (${EVAL_DB})`)
  if (!env.CF_SANDBOX_ACCOUNT_ID) throw new DoorRefusal('refusing: CF_SANDBOX_ACCOUNT_ID is not set, so the target is not known to be the sandbox account')
  return name
}


/** `nowSql` is the SQL for "now" in ms (default D1_NOW_MS; tests give a fixed integer to step a clock). */
export function createDoor(run: RunSql, nowSql: () => string = () => D1_NOW_MS): MemoryDoor {
  return {
    async hasChat(id) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new DoorRefusal('not a chat id')
      return (await run(`SELECT 1 AS one FROM chats WHERE id = ${sqlString(id)}`)).length > 0
    },
    async rows() {
      const out = await run('SELECT id, scope, owner_id, text, status, rev FROM memories ORDER BY n')
      return out.map((r) => ({ id: String(r.id), scope: r.scope as MemoryRow['scope'], ownerId: r.owner_id === null ? null : String(r.owner_id), text: String(r.text), status: r.status as MemoryRow['status'], rev: Number(r.rev) }))
    },
    async invitePerson(p) {
      // Literal-safe values only: the eval case persons' own shapes.
      if (!MEMBER_ID.test(p.id)) throw new DoorRefusal('not a member id')
      if (!/^eval-[a-z0-9-]{1,80}@example\.test$/.test(p.email)) throw new DoorRefusal('not an eval case person\'s email')
      // A plain name, or one of the write-injection set's planted names (#533), each a fixed literal.
      if (!/^[A-Za-z0-9 ]{1,60}$/.test(p.name) && !PLANTED_NAME_LIST.includes(p.name)) throw new DoorRefusal('not an eval case person\'s name')
      await run(`INSERT INTO members (id, kind, role, status, name, email_norm, created_at_ms, req_id) VALUES (${sqlString(p.id)}, 'person', 'member', 'invited', ${sqlString(p.name)}, ${sqlString(p.email)}, ${Date.now()}, 'eval')`)
    },
    async addTeammate(p) {
      if (!MEMBER_ID.test(p.id)) throw new DoorRefusal('not a member id')
      if (!/^eval-[a-z0-9-]{1,80}@example\.test$/.test(p.email)) throw new DoorRefusal('not an eval teammate\'s email')
      if (!PLANTED_NAME_LIST.includes(p.name)) throw new DoorRefusal('not a planted name')
      await run(`INSERT INTO members (id, kind, role, status, name, email_norm, created_at_ms, req_id) VALUES (${sqlString(p.id)}, 'person', 'member', 'active', ${sqlString(p.name)}, ${sqlString(p.email)}, ${Date.now()}, 'eval')`)
    },
    async removeTeammate(id) {
      if (!MEMBER_ID.test(id)) throw new DoorRefusal('not a member id')
      await run(`UPDATE members SET status = 'removed' WHERE id = ${sqlString(id)} AND email_norm LIKE 'eval-%@example.test'`)
      const left = await run(`SELECT id FROM members WHERE id = ${sqlString(id)} AND status <> 'removed'`)
      if (left.length !== 0) throw new DoorRefusal(`the teammate ${id} is still on the team`)
    },
    async insert(facts) {
      if (facts.length === 0) return
      const now = Date.now()
      const values = facts.map((f) => {
        if (!MEMORY_ID.test(f.id)) throw new DoorRefusal(`not a memory id: ${f.id}`)
        if (f.ownerId !== null && !MEMBER_ID.test(f.ownerId)) throw new DoorRefusal('not a member id')
        return `(${sqlString(f.id)}, ${sqlString(f.scope)}, ${f.ownerId === null ? 'NULL' : sqlString(f.ownerId)}, ${sqlString(f.text)}, 'active', 'eval', ${now}, ${now})`
      })
      await run(`INSERT INTO memories (id, scope, owner_id, text, status, created_by, created_at_ms, updated_at_ms) VALUES ${values.join(', ')}`)
    },
    async clear() {
      const now = nowSql()
      await run(`UPDATE routines SET deleted_at_ms = ${now}, updated_at_ms = ${now}, rev = rev + 1, req_id = 'eval' WHERE origin = 'team' AND deleted_at_ms IS NULL`)
      const live = await run("SELECT id FROM routines WHERE origin = 'team' AND deleted_at_ms IS NULL")
      if (live.length !== 0) throw new DoorRefusal(`${live.length} team routines are still live after the clear`)
      await run('DELETE FROM team_requests')
      await run('DELETE FROM memories')
    },
    async insertApproval(a) {
      if (!ACTION_ID.test(a.id)) throw new DoorRefusal('not an action id')
      if (!CHAT_ID.test(a.chatId)) throw new DoorRefusal('not a chat id')
      if (!MEMBER_ID.test(a.askedBy)) throw new DoorRefusal('not a member id')
      if (!CARD_TEXT.test(a.title) || !CARD_TEXT.test(a.line)) throw new DoorRefusal('not a card title or line the door writes')
      const now = nowSql()
      const card = JSON.stringify({ title: a.title, lines: [a.line], label: 'Shopify (eval)', nudge: false })
      const args = JSON.stringify({ orderIds: ['gid://shopify/Order/1'], tags: ['eval'] })
      await run(`INSERT INTO outbox_actions (id, rev, state, verdict, origin, via, asked_by, approver, chat_id, account_id, account_gen, operation,
        policy_rev, scope_json, scope_key, args_json, payload_hash, records, units, card_json, expires_at_ms, created_at_ms, updated_at_ms)
        VALUES (${sqlString(a.id)}, 1, 'waiting', 'ask', 'chat', 'approval_request', ${sqlString(a.askedBy)}, ${sqlString(a.askedBy)}, ${sqlString(a.chatId)},
        'shopify:store', 0, 'shopify.order.tag_add', 1, '{"shop":"eval"}', 'shop=eval', ${sqlString(args)}, ${sqlString(a.id)}, 1, 1, ${sqlString(card)},
        ${now} + 604800000, ${now}, ${now})`)
    },
    async deleteApprovals(ids) {
      if (ids.length === 0) return
      for (const id of ids) if (!ACTION_ID.test(id)) throw new DoorRefusal('not an action id')
      await run(`DELETE FROM outbox_actions WHERE id IN (${ids.map(sqlString).join(', ')})`)
    },
    async setSpendingCap(cap) {
      // The product's own rule for the field (settings-table.ts capOk): whole dollars or cents, above $0, at most $100,000.
      if (!/^\$\d{1,6}$/.test(cap) || !capOk(cap)) throw new DoorRefusal('not a Spending cap in whole dollars the product reads')
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 's:cap', ${sqlString(JSON.stringify(cap))}, 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
    },
    async setJobCap(cap) {
      // The product's own rule for the field (settings-table.ts `s:job_cap`): whole dollars, from the $0.25 floor to $100.
      if (!/^\$\d{1,3}$/.test(cap) || !capOk(cap, MAX_JOB_BUDGET_USD, MIN_JOB_BUDGET_USD)) throw new DoorRefusal('not a job budget in whole dollars the product reads')
      const value = JSON.stringify(cap)
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 's:job_cap', ${sqlString(value)}, 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
      const now = (await run("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 's:job_cap'")).map((r) => r.value_json)
      if (now.length !== 1 || now[0] !== value) throw new DoorRefusal(`the job budget reads back ${JSON.stringify(now)}, not ${value}`)
    },
    async setDefaultModel(label) {
      if (!/^[A-Za-z]{1,20}$/.test(label)) throw new DoorRefusal('not a Default model label')
      const value = JSON.stringify(label)
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 'g:mode', ${sqlString(value)}, 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
      const now = (await run("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'g:mode'")).map((r) => r.value_json)
      if (now.length !== 1 || now[0] !== value) throw new DoorRefusal(`the Default model reads back ${JSON.stringify(now)}, not ${value}`)
    },
    async takeLease(tag) {
      if (!LEASE_TAG.test(tag)) throw new DoorRefusal('not an eval lease tag')
      const now = nowSql()
      await run(
        `INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES (${sqlString(TEST_SHOP_OWNER)}, '${LEASE_KEY}', json_object('tag', ${sqlString(tag)}, 'until', ${now} + ${EVAL_LEASE_TTL_MS}), 1, ${now}, 'eval', 'eval') ` +
          `ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms ` +
          `WHERE json_extract(settings.value_json, '$.until') <= ${now} OR json_extract(settings.value_json, '$.tag') = ${sqlString(tag)}`,
      )
      const held = (await run(`SELECT value_json FROM settings WHERE owner = ${sqlString(TEST_SHOP_OWNER)} AND key = '${LEASE_KEY}'`)).map((r) => r.value_json)
      let lease: { tag?: unknown; until?: unknown } | null = null
      try { lease = held.length === 1 ? JSON.parse(String(held[0])) : null } catch { /* named below */ }
      if (lease?.tag !== tag || typeof lease.until !== 'number') {
        const other = typeof lease?.tag === 'string' ? lease.tag : JSON.stringify(held)
        const till = typeof lease?.until === 'number' ? ` until ${new Date(lease.until).toISOString()}` : ''
        throw new DoorRefusal(`refusing: another eval run (${other}) holds the eval deployment${till}: one runner per eval deployment`)
      }
    },
    async releaseLease(tag) {
      if (!LEASE_TAG.test(tag)) throw new DoorRefusal('not an eval lease tag')
      const mine = `owner = ${sqlString(TEST_SHOP_OWNER)} AND key = '${LEASE_KEY}' AND json_extract(value_json, '$.tag') = ${sqlString(tag)}`
      await run(`DELETE FROM settings WHERE ${mine}`)
      if ((await run(`SELECT 1 AS one FROM settings WHERE ${mine}`)).length !== 0) throw new DoorRefusal('the eval lease is still held after giving it back')
    },
    async testShop() {
      const rows = await run(`SELECT value_json FROM settings WHERE owner = ${sqlString(TEST_SHOP_OWNER)} AND key = ${sqlString(TEST_SHOP_KEY)}`)
      return rows.length === 0 ? null : String(rows[0]!.value_json)
    },
    async setWebfetchHosts(hosts) {
      if (hosts === null) {
        await run("DELETE FROM settings WHERE owner = 'brand' AND key = 't:webfetch'")
        return
      }
      // The server's own rule for the setting (parseHostlist, which the run's settings read): a list it would read as no
      // list at all (deny every host) is refused here, loud. Its hostnames hold no quote, so the statement stays literal.
      const text = hosts.join('\n')
      if (hosts.length === 0 || parseHostlist(text)?.length !== hosts.length) throw new DoorRefusal('not a host list the server reads (parseHostlist)')
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:webfetch', ${sqlString(JSON.stringify(hosts.join('\n')))}, 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
    },
    async setWebSearch(on) {
      if (typeof on !== 'boolean') throw new DoorRefusal('t:websearch is a switch: true or false')
      if (!on) {
        await run("DELETE FROM settings WHERE owner = 'brand' AND key = 't:websearch'")
        return
      }
      await run(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id) VALUES ('brand', 't:websearch', 'true', 1, ${Date.now()}, 'eval', 'eval') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = settings.rev + 1, updated_at_ms = excluded.updated_at_ms, updated_by = 'eval', req_id = 'eval'`)
    },
  }
}

export interface WranglerOptions {
  database: string
  /** The sandbox wrangler config that binds the database (wrangler finds the D1 id there). */
  config: string
  env: Record<string, string | undefined>
  /**
   * The database rule: 'eval' (the default, assertSandboxDatabase: EVAL_DB only) or 'morning-check'
   * (assertMorningCheckDatabase: EVAL_DB or a PR's test database). Only these two: no caller brings its own.
   */
  rule?: 'eval' | 'morning-check'
  /** Reads the config file (tests). */
  readConfig?: (file: string) => string
  /**
   * Replaces the process spawn (tests). Gets the argv after `wrangler`; `output` is stdout and stderr together, read only to
   * tell a transient failure from a permanent one (never logged).
   */
  spawn?: (args: string[], env: Record<string, string | undefined>) => WranglerResult | Promise<WranglerResult>
  /** A read's retries (#691): where each is reported, the backoff (tests). */
  retry?: RetryOptions
}

export interface WranglerResult {
  status: number | null
  stdout: string
  output?: string
  /** The call's own deadline ended it (a null status otherwise means a signal from outside: a cancel, never retried). */
  timedOut?: boolean
}

/**
 * How long one wrangler call may take (#672): killed past this, npx and every process under it (#690), and its null status
 * is a refusal (a read retries it, #691).
 */
export const WRANGLER_TIMEOUT_MS = 120_000
const WRANGLER_MAX_OUTPUT = 16 * 1024 * 1024
/** How long output may stay open after the call exits (#713), before its streams are closed. */
export const WRANGLER_DRAIN_MS = 5_000

/**
 * Every process under `root` (its children, theirs, and so on), from one `ps` listing (macOS and Linux both take
 * `-A -o pid=,ppid=`).
 */
function descendants(root: number, ps: string): number[] {
  let listing: string
  try {
    listing = execFileSync(ps, ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) {
    // Never a silent "no children" (#715): that would kill npx alone and leave wrangler running, the #690 orphan.
    throw new ProcessTreeUnlisted((e as NodeJS.ErrnoException).code ?? `exit ${(e as { status?: unknown }).status ?? '?'}`)
  }
  const kids = new Map<number, number[]>()
  for (const line of listing.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  }
  // Visited once each (#718): a snapshot taken mid-change (pid reuse) can hold a cycle, which must not loop forever.
  const seen = new Set<number>([root])
  const out: number[] = []
  const queue = [root]
  while (queue.length) {
    for (const k of kids.get(queue.shift()!) ?? []) {
      if (seen.has(k)) continue
      seen.add(k)
      out.push(k)
      queue.push(k)
    }
  }
  return out
}

/** `ps` could not list the processes (missing, or a busybox one without `-A`): a wrangler tree can't be killed whole. */
export class ProcessTreeUnlisted extends DoorRefusal {
  constructor(why: string) {
    super(`the process tree could not be listed (ps -A -o pid=,ppid= failed: ${why}), so a wrangler call can't be stopped whole: the run stops (install procps)`)
  }
}

/** Refuses (ProcessTreeUnlisted) unless `ps` can list the processes: checked before any paid turn (#715). */
export function assertProcessTreeListable(ps = 'ps'): void {
  descendants(process.pid, ps)
}

const sendSignal = (pid: number, sig: NodeJS.Signals) => {
  // Never 0 (this process's group), -1 (every process) or init (#713): only a real child's pid.
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    process.kill(pid, sig)
  } catch {
    // Already gone (ESRCH).
  }
}

/**
 * Kills `root` and every process under it (#690, #711): the root is stopped before the first listing (#718: it can't fork,
 * or exit and hand its children to init, while `ps` runs), each found process is stopped, the tree walked again for
 * anything started meanwhile, then all are killed. If `ps` fails the root is still killed, and ProcessTreeUnlisted is
 * thrown (#715): what was under it may still run, and the caller must say so.
 */
export function killTree(root: number, ps = 'ps'): void {
  if (!Number.isInteger(root) || root <= 1) return
  sendSignal(root, 'SIGSTOP')
  const seen = new Set<number>([root])
  try {
    for (let pass = 0; pass < 3; pass++) {
      const found = descendants(root, ps).filter((p) => !seen.has(p))
      if (found.length === 0) break
      for (const p of found) {
        seen.add(p)
        sendSignal(p, 'SIGSTOP')
      }
    }
  } finally {
    for (const p of seen) sendSignal(p, 'SIGKILL')
  }
}

/** Wrangler calls still running: killed, with everything under them, when this process exits (#690). */
const live = new Set<number>()
let exitHooked = false

/**
 * After a cancel (#716): wrangler calls run in a process group of their own, so a second Ctrl-C (or a SIGINT then a
 * SIGTERM to the run's group) can't kill the close's own calls, the lease release above all. Their deadline still kills
 * their whole tree, and the run's exit too; only a SIGKILL to the run's group no longer reaches them, and what the close
 * runs is cleanup (the Slack reset, the lease release), which may finish on its own.
 */
let shielded = false
export function shieldWranglerCalls(): void {
  shielded = true
}
export const wranglerCallsShielded = (): boolean => shielded

/**
 * One wrangler call, asynchronous (a cancel's close is never stuck behind it), in this process's own process group
 * (#711): a SIGHUP, SIGINT or a SIGKILL sent to the run's group reaches npx and wrangler too, so none is left running
 * with no deadline (#690's `detached` took them out of the group, which a group kill then missed). Once a cancel has begun
 * (#716), in a group of their own instead (shieldWranglerCalls). Its deadline kills npx and every process under it
 * (killTree), not npx alone, which once left wrangler free to land its SQL after the lease went back; so does this
 * process's exit. `bin` replaces `npx --no-install wrangler`, `ps` the process lister (tests).
 */
export function spawnWrangler(args: string[], env: Record<string, string | undefined>, o: { bin?: readonly string[]; timeoutMs?: number; ps?: string; maxOutput?: number } = {}): Promise<WranglerResult & { timedOut: boolean }> {
  const [cmd, ...pre] = o.bin ?? ['npx', '--no-install', 'wrangler']
  const timeoutMs = o.timeoutMs ?? WRANGLER_TIMEOUT_MS
  const ps = o.ps ?? 'ps'
  const maxOutput = o.maxOutput ?? WRANGLER_MAX_OUTPUT
  if (!exitHooked) {
    exitHooked = true
    process.on('exit', () => {
      for (const pid of live) {
        try {
          killTree(pid)
        } catch (e) {
          process.stderr.write(`${(e as Error).message}\n`)
        }
      }
    })
  }
  return new Promise((resolve, reject) => {
    const child = spawnChild(cmd!, [...pre, ...args], { cwd: path.resolve(import.meta.dirname, '../..'), env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: shielded })
    const pid = child.pid
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let tooBig = false
    let treeErr: unknown
    let exitCode: number | null = null
    let drain: ReturnType<typeof setTimeout> | undefined
    // The tree's kill, only while the call is still running (#718: after its exit the pid may already be someone else's).
    const stop = () => {
      if (pid === undefined || !live.has(pid)) return
      try {
        killTree(pid, ps)
      } catch (e) {
        treeErr = e
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    if (pid !== undefined) live.add(pid)
    const take = (into: 'out' | 'err') => (d: string) => {
      if (into === 'out') stdout += d
      else stderr += d
      if (stdout.length + stderr.length > maxOutput && !tooBig) {
        tooBig = true
        stop()
        // Output still coming after the exit (a leftover holding the pipe): the streams close, so the call ends.
        if (pid === undefined || !live.has(pid)) { child.stdout.destroy(); child.stderr.destroy() }
      }
    }
    child.stdout.setEncoding('utf8').on('data', take('out'))
    child.stderr.setEncoding('utf8').on('data', take('err'))
    // The outcome is the exit's (#713): the deadline stops at the exit, so a call that ended just before it is never a
    // false timeout while its output drains. Output still open after the exit (a leftover child holding the pipe) gets a
    // bounded drain, then the streams are closed and the exit code stands.
    child.on('exit', (code) => {
      clearTimeout(timer)
      exitCode = code
      if (pid !== undefined) live.delete(pid)
      drain = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy() }, WRANGLER_DRAIN_MS)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      if (pid !== undefined) live.delete(pid)
      // npx missing or not runnable: a refusal (a bad setup, never retried), naming only the error's code.
      reject(new DoorRefusal(`wrangler could not start (${(e as NodeJS.ErrnoException).code ?? e.name})`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(drain)
      if (pid !== undefined) live.delete(pid)
      // The tree couldn't be listed (#715): npx is dead, but what ran under it may not be. The run stops on this.
      if (treeErr) reject(treeErr)
      else if (tooBig) reject(new DoorRefusal(`wrangler d1 execute answered more than ${maxOutput} bytes`))
      else resolve({ status: timedOut ? null : (exitCode ?? code), stdout, output: `${stdout}\n${stderr}`, timedOut })
    })
  })
}

const defaultSpawn: NonNullable<WranglerOptions['spawn']> = (args, env) => spawnWrangler(args, env)

/** One wrangler call at a time, as when they ran synchronously: a read never races a write of the same run. */
let wranglerTail: Promise<unknown> = Promise.resolve()
export const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
  const p = wranglerTail.then(work, work)
  wranglerTail = p.then(() => undefined, () => undefined)
  return p
}

/** A statement that only reads (one SELECT, nothing after it): the only kind a transient failure retries (#691). */
export const readOnlySql = (sql: string): boolean => /^\s*SELECT\b/i.test(sql) && !/;\s*\S/.test(sql)

/**
 * The D1 errors its docs say to retry (https://developers.cloudflare.com/d1/observability/debug-d1/, "List of D1_ERRORs"
 * and "API error codes", read 2026-11-28), as the API words them: a platform reset, a lost connection, an unreachable node
 * or an overloaded database. Not the CPU or memory limit, the size or free-tier limits: those fail the same query again.
 */
export const D1_TRANSIENT_MESSAGES: readonly string[] = [
  'D1 DB reset because its code was updated.',
  'Internal error while starting up D1 DB storage caused object to be reset.',
  'Network connection lost.',
  'Replica disconnected from primary.',
  'Internal error in D1 DB storage caused object to be reset.',
  'Cannot resolve D1 DB due to transient issue on remote node.',
  'Can\'t read from request stream because client disconnected.',
  'D1 DB storage operation exceeded timeout which caused object to be reset.',
  'D1 DB is overloaded. Requests queued for too long.',
  'D1 DB is overloaded. Too many requests queued.',
  'D1 DB is overloaded. Too many resources consumed within a 10 second window',
]
/** D1's "DB overloaded" API code (the same docs: retry with backoff). */
const D1_OVERLOADED = 7429
/** API codes that refuse the token or the account: never retried, whatever else the answer says. */
const AUTH_CODES = new Set([10000, 7403])
/**
 * D1's documented API codes (the same docs, "API error codes"), none of them a rate limit: a Retry-After beside one of these
 * is not a 429 (#717). 7429 is handled before; a 7500 that is one of D1_TRANSIENT_MESSAGES too.
 */
const NOT_A_RATE_LIMIT = new Set([7403, 7404, 7406, 7500, 10000])
/** The text wrangler gives the API's own JSON answer (throwFetchError), as against its WAF and malformed-page errors. */
const API_ANSWER = /^A request to the Cloudflare API \(.*\) failed\.$/

/**
 * Why a failed wrangler call is clearly transient, as a fixed label, or null (#691, #710). Read from what wrangler 4.162
 * prints with --json (its d1 execute: `{"error": <the APIError>}` on stdout; samples in fixtures/wrangler-d1-errors, made
 * by its capture.mjs against a fake API). Wrangler never prints the HTTP status there, so the signs are its own:
 *   - D1's overloaded code 7429, or one of D1_TRANSIENT_MESSAGES in a note (each note is the API's message and code);
 *   - a rate limit (#717): wrangler prints no status, so a 429 is read as `retryAfterMs` (which it takes from a Retry-After
 *     header on any status) on the API's own JSON answer only, never its WAF-challenge or malformed-page errors, and never
 *     beside one of D1's documented codes (NOT_A_RATE_LIMIT: a 404 7404 with a Retry-After is still a missing database);
 *   - a gateway's non-JSON page: "Received a malformed response from the API" with a `-> 5xx` note;
 *   - a network failure or wrangler's own timeout, which it prints as the error's text alone ("fetch failed").
 * Never transient: an auth code (10000, 7403), our deadline's kill only when it was ours (a signal from outside is a
 * cancel), output that isn't wrangler's JSON, and anything else (a SQL error, a missing database, a bad config).
 */
export function wranglerTransient(r: WranglerResult): string | null {
  if (r.status === null) return r.timedOut ? 'a timeout' : null
  let e: { text?: unknown; notes?: { text?: unknown }[]; code?: unknown; name?: unknown; retryAfterMs?: unknown } | undefined
  try {
    e = (JSON.parse(r.stdout) as { error?: typeof e }).error
  } catch {
    return null
  }
  if (!e || typeof e !== 'object') return null
  const notes = (Array.isArray(e.notes) ? e.notes : []).map((n) => (typeof n?.text === 'string' ? n.text : ''))
  const codes = [e.code, ...notes.map((n) => Number(/\[code: (\d+)\]\s*$/.exec(n)?.[1]))]
  if (codes.some((c) => typeof c === 'number' && AUTH_CODES.has(c))) return null
  if (e.name === 'APIError') {
    if (codes.includes(D1_OVERLOADED)) return 'D1 overloaded'
    if (notes.some((n) => D1_TRANSIENT_MESSAGES.some((m) => n.startsWith(m)))) return 'a transient D1 error'
    if (typeof e.retryAfterMs === 'number' && typeof e.text === 'string' && API_ANSWER.test(e.text) && !codes.some((c) => typeof c === 'number' && NOT_A_RATE_LIMIT.has(c))) return 'a rate limit (Retry-After)'
    if (e.text === 'Received a malformed response from the API' && notes.some((n) => / -> 5\d\d\b/.test(n))) return 'a 5xx from the API'
    return null
  }
  // Not an API answer at all: wrangler prints a thrown error as its message alone.
  if (typeof e.text !== 'string') return null
  if (/^fetch failed$|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/.test(e.text)) return 'a network error'
  if (/aborted due to timeout/.test(e.text)) return 'a timeout'
  return null
}

/** `wrangler d1 execute <name> --remote --json --command <sql>`, for a database that passes its rule (`rule`) only. */
export function wranglerRunner(o: WranglerOptions): RunSql {
  const query = wranglerQueries(o)
  return async (sql) => (await query(sql))[0]?.results ?? []
}

interface QueryResult {
  results: Record<string, unknown>[]
  meta: { changes: number }
  success: boolean
}

/** D1 executes semicolon-joined statements passed to --command as a single batch. */
export function wranglerQueries(o: WranglerOptions): (sql: string) => Promise<QueryResult[]> {
  const database = o.rule === 'morning-check' ? assertMorningCheckDatabase(o.database, o.env) : assertSandboxDatabase(o.database, o.env)
  if (!o.config) throw new DoorRefusal('refusing: INHOUSE_EVAL_WRANGLER_CONFIG is not set (the sandbox config that binds the database)')
  // One absolute path, made once, goes to the checks and to wrangler (which runs with cwd app/): they can't read two different files.
  const configPath = path.resolve(o.config)
  // The config must name the sandbox account (the value the sandbox lock is given) and bind this database, as seed-remote.mjs requires.
  let config: { account_id?: unknown; d1_databases?: { database_name?: unknown }[] }
  try { config = JSON.parse((o.readConfig ?? ((f) => readFileSync(f, 'utf8')))(configPath)) } catch { throw new DoorRefusal('refusing: the wrangler config can\'t be read as plain JSON') }
  if (config.account_id !== o.env.CF_SANDBOX_ACCOUNT_ID) throw new DoorRefusal('refusing: the wrangler config\'s account_id is not CF_SANDBOX_ACCOUNT_ID')
  if (!(config.d1_databases ?? []).some((d) => d?.database_name === database)) throw new DoorRefusal(`refusing: the wrangler config binds no D1 named ${database}`)
  // Wrangler works in the sandbox account named by CF_SANDBOX_ACCOUNT_ID, never one the shell happens to default to.
  const env = { ...o.env, CLOUDFLARE_ACCOUNT_ID: o.env.CF_SANDBOX_ACCOUNT_ID }
  const spawn = o.spawn ?? defaultSpawn
  const once = async (sql: string, retryable: boolean): Promise<QueryResult[]> => {
    const r = await oneAtATime(async () => spawn(['d1', 'execute', database, '--remote', '--config', configPath, '--json', '--yes', '--command', sql], env))
    const failed = r.status === null ? new DoorRefusal(`wrangler d1 execute did not end (killed after ${WRANGLER_TIMEOUT_MS / 1000} s, or by a signal)`) : r.status !== 0 ? new DoorRefusal(`wrangler d1 execute exited ${r.status}`) : null
    if (failed) {
      const why = retryable ? wranglerTransient(r) : null
      throw why ? new TransientDoorError(why, failed) : failed
    }
    try {
      return JSON.parse(r.stdout) as QueryResult[]
    } catch {
      throw new DoorRefusal('wrangler d1 execute answered something that is not JSON')
    }
  }
  // A read retries a transient failure (#691); a write never does: it may have landed.
  return async (sql) => (readOnlySql(sql) ? withRetries('a D1 read through wrangler', () => once(sql, true), o.retry) : once(sql, false))
}
