// A fake FileLedgerPort (p3-design section 12) until W3's real one lands, and the files anchor's answer in compose.ts
// until then. `inputs` lists each chat's input file ids; `pending` holds outputs waiting for `confirm`.
import type { ChatFile, FileLedgerPort } from '../ports.ts'

export class FakeFileLedger implements FileLedgerPort {
  calls: { method: keyof FileLedgerPort; args: unknown[] }[] = []
  inputs = new Map<string, Set<string>>()
  /** Keyed `<chatId> <turnId> <path> <sha256>`. */
  pending = new Map<string, ChatFile>()

  async confirm(chatId: string, turnId: string, path: string, sha256: string, nowMs: number): Promise<ChatFile | null> {
    this.calls.push({ method: 'confirm', args: [chatId, turnId, path, sha256, nowMs] })
    return this.pending.get(`${chatId} ${turnId} ${path} ${sha256}`) ?? null
  }
  async inputsOf(chatId: string, fileIds: readonly string[]): Promise<{ ok: true } | { missing: string[] }> {
    this.calls.push({ method: 'inputsOf', args: [chatId, fileIds] })
    const have = this.inputs.get(chatId) ?? new Set<string>()
    const missing = fileIds.filter(id => !have.has(id))
    return missing.length === 0 ? { ok: true } : { missing }
  }
}
