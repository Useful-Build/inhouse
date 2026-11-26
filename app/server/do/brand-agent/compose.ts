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
import { createLagTable, outboxPauseHook } from '../../outbox/gate.ts'
import { outboxNotifier } from '../../outbox/notify.ts'
import { questionHook } from '../../questions/ask.ts'
import { QUESTIONS_ON } from '../../questions/switch.ts'
import type { QuestionWake } from '../../questions/agent.ts'

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
    // Stage 1 M2-Q (N16): a deferred `question_ask` asks its question (server/questions/ask.ts); while questions are off
    // (every deployable build until M2-H, server/questions/switch.ts) it is resumed at once and nothing is asked.
    onDeferred: questionHook(QUESTIONS_ON),
  }
}

// ---------- Stage 1 M2-Q's anchor (N16): what wakes on an answered question ----------
// M1-B's job engine adds its line here (a job whose continuation waits on the chat's question).
export function questionWakes(_env: Env, _parts: BrandAgentParts): QuestionWake[] {
  return []
}

/** Registers P6's hooks on the engine (index.ts, once per object): each pause hook in order, `onDeferred` when set. */
export function wireP6(core: { registerPauseHook(h: PauseHook): void; setOnDeferred(h: OnDeferredHook | null): void }, hooks: P6Hooks): void {
  for (const h of hooks.pause) core.registerPauseHook(h)
  if (hooks.onDeferred !== null) core.setOnDeferred(hooks.onDeferred)
}
