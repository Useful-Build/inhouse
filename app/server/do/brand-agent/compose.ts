// The BrandAgent's composition root (p3-design section 12): the real pool, files and usage ports, one anchor per owner.
// Each owner fills only its own anchor, in its own PR; nobody edits another's. W1's first PR typed each anchor with its
// port (ports.ts) and made it return the fake under testing/; each owner then returns its real port there. The pool
// lives in the BrandAgent, so its anchor also gets the object's parts (its SQLite, scheduler, clock and placement hooks).
import type { BrandAgentParts, BrandAgentPorts, FileLedgerPort, OnDeferredHook, PauseHook, RunnerPoolPort, UsageLedgerPort } from './ports.ts'
import { createUsageLedger } from '../../usage/ledger.ts'
import { fileStore } from '../../files-io/store.ts'
import type { StoredFile } from '../../files-io/store.ts'
import type { ChatFile } from './ports.ts'
import { runnerPool } from '../runner/pool.ts'
import type { JobDeps } from './jobs/types.ts'
import { jobNoticeInput } from './jobs/notice.ts'
import { addNotice } from '../../notices/store.ts'
import { resolveTurnSettings } from '../../api/runs.ts'
import { openStores } from '../../db/stores.ts'
import { createLagTable, outboxPauseHook } from '../../outbox/gate.ts'
import type { AsksDeps } from './asks.ts'
import { outboxNotifier } from '../../outbox/notify.ts'
import { questionHook } from '../../questions/ask.ts'
import { QUESTIONS_ON } from '../../questions/switch.ts'

/** The ports the BrandAgent runs on, built once per object from its env. */
export function composePorts(env: Env, parts: BrandAgentParts): BrandAgentPorts {
  return {
    pool: poolPort(env, parts),

    files: filesPort(env),

    usage: usagePort(env),
  }
}

// ---------- W2's anchor (p3-w2.md): RunnerPoolPort ----------
function poolPort(env: Env, parts: BrandAgentParts): RunnerPoolPort {
  return runnerPool(env, parts)
}

// ---------- W3's anchor (p3-w3.md): FileLedgerPort ----------
function filesPort(env: Env): FileLedgerPort {
  const files = fileStore({ db: env.DB, bucket: env.FILES })
  const chatFile = (f: StoredFile): ChatFile =>
    ({ id: f.id, chatId: f.chatId, kind: f.kind, path: f.path, name: f.name, contentType: f.contentType, bytes: f.bytes, sha256: f.sha256, turnId: f.turnId })
  return {
    async confirm(chatId, turnId, path, sha256, nowMs) {
      const f = await files.confirm(chatId, turnId, path, sha256, nowMs)
      return f && chatFile(f)
    },
    async inputsOf(chatId, fileIds) {
      const r = await files.inputsOf(chatId, fileIds)
      return 'missing' in r ? r : { ok: true, files: r.files.map(chatFile) }
    },
  }
}

// ---------- W4's anchor (p3-w4.md): UsageLedgerPort ----------
// The D1 ledger (usage/ledger.ts). Its `settle` also takes the runner's cost as a 4th argument (stored, never added).
function usagePort(env: Env): UsageLedgerPort {
  return createUsageLedger({ db: env.DB })
}

// ---------- P6's anchor (p6-design section 14, asks 3 and 4): pause hooks and onDeferred ----------
// P6 W1 (the pause hook, T10) and P6 W3 (`onDeferred`) fill only this function, lines only, in wave 5 (A4, 2026-11-20).

/** What P6 hooks into the BrandAgent. */
export interface P6Hooks {
  pause: PauseHook[]
  onDeferred: OnDeferredHook | null
}

export function p6Hooks(env: Env, parts: BrandAgentParts): P6Hooks {
  // Stage 1 M2-B: the outbox's lag record (the gate health signal), created once here so its reads do no DDL.
  createLagTable(parts.sql)
  return {
    // Stage 1 M2-B (N12): the outbox's gate kept in step with the object's pause flag on every Pause and Resume.
    pause: [outboxPauseHook({ db: env.DB, sql: parts.sql, notify: outboxNotifier(env) })],
    // Stage 1 M2-Q (N16): a deferred `question_ask` asks its question (server/questions/ask.ts). Questions are on in
    // every build since M2-H (server/questions/switch.ts); off, it is resumed at once and nothing is asked.
    onDeferred: questionHook(QUESTIONS_ON),
  }
}

/** Registers P6's hooks on the engine (index.ts, once per object): each pause hook in order, `onDeferred` when set. */
export function wireP6(core: { registerPauseHook(h: PauseHook): void; setOnDeferred(h: OnDeferredHook | null): void }, hooks: P6Hooks): void {
  for (const h of hooks.pause) core.registerPauseHook(h)
  if (hooks.onDeferred !== null) core.setOnDeferred(hooks.onDeferred)
}

// ---------- M1-B's anchor (Stage 1, N3): the job engine's ports ----------
// `texts` stays null until M1-P wires the job texts (N20): while it is null no turn ever becomes a job.

export function jobDeps(env: Env): JobDeps {
  return {
    texts: null,
    async memberActive(memberId) {
      const row = await env.DB.prepare('SELECT status FROM members WHERE id = ?').bind(memberId).first<{ status: string }>()
      return row !== null && row.status === 'active'
    },
    async settings(pickerId) {
      const r = await resolveTurnSettings(openStores(env).settings, pickerId)
      if ('refused' in r) return { refused: r.refused.code === 'invalid' ? 'invalid' : 'model_off' }
      return r
    },
    async notify(n) {
      await env.DB.batch([addNotice(env.DB, jobNoticeInput(n))])
    },
  }
}

// ---------- M2-D's anchor (Stage 1, N14): the asks' ports ----------
// `texts` stays null until M2-G wires the action texts (N20): while it is null no resume turn is ever sent.

export function asksDeps(env: Env): AsksDeps {
  return {
    texts: null,
    settings: jobDeps(env).settings,
  }
}
