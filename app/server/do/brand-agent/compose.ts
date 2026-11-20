// The BrandAgent's composition root (p3-design section 12): the real pool, files and usage ports, one anchor per owner.
// Each owner fills only its own anchor, in its own PR; nobody edits another's. W1's first PR typed each anchor with its
// port (ports.ts) and made it return the fake under testing/; each owner then returns its real port there. The pool
// lives in the BrandAgent, so its anchor also gets the object's parts (its SQLite, scheduler, clock and placement hooks).
import type { BrandAgentParts, BrandAgentPorts, FileLedgerPort, RunnerPoolPort, UsageLedgerPort } from './ports.ts'
import { fileStore } from '../../files-io/store.ts'
import type { StoredFile } from '../../files-io/store.ts'
import type { ChatFile } from './ports.ts'
import { FakeUsageLedger } from './testing/fake-usage.ts'
import { runnerPool } from '../runner/pool.ts'

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
function usagePort(_env: Env): UsageLedgerPort {
  return new FakeUsageLedger()
}
