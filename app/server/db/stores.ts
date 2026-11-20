// The D1 stores (W1's `AuthStores` and the members and settings routes' own), made once per request from the Worker's
// env (server/api.ts `ApiParts.stores`). Every method takes data and returns data: none hands out a statement, a
// batch or a sub-store (the store contract in server/routes.ts), so the stores close cleanly after an access refusal.
import type { AuditSink, AuthStores, GrantStore, MemberDirectory } from '../auth/stores.ts'
import { AuditKeyMissingError, auditInsert } from './audit.ts'
import type { AuditHook } from './audit.ts'
import { grantStore } from './grants.ts'
import { memberStore } from './members.ts'
import type { MemberStore } from './members.ts'
import { runBatch } from './sql.ts'
import { settingStore } from './settings.ts'
import type { SettingStore } from './settings.ts'

export interface Stores extends AuthStores {
  members: MemberDirectory & MemberStore
  grants: GrantStore
  audit: AuditSink
  settings: SettingStore
}

/** What the stores read from the Worker's env. `AUDIT_HASH_KEY` is a secret on the product Worker (a var in the test build). */
export interface StoresEnv {
  DB: D1Database
  AUDIT_HASH_KEY?: string
}

/**
 * The stores over this env's D1. Throws when `AUDIT_HASH_KEY` is unset, so a Worker without it answers 503 instead of
 * logging a value it can't redact. `hook` is for tests only (it swaps every audit statement).
 */
export function openStores(env: StoresEnv, hook?: AuditHook): Stores {
  const hashKey = env.AUDIT_HASH_KEY
  if (!hashKey) throw new AuditKeyMissingError()
  const db = env.DB
  const members = memberStore({ db, hook })
  const audit: AuditSink = {
    async supportAccess(principal, at) {
      if (!principal.grant) throw new Error('supportAccess: no live grant')
      const line = auditInsert({
        atMs: at.nowMs,
        actorId: principal.memberId,
        args: { action: 'support.access', grantId: principal.grant.id, method: at.method as 'GET', route: at.route as '/api/members' },
        target: { kind: 'grant', id: principal.grant.id },
        requestId: principal.requestId,
      }, null)
      await runBatch(db, [hook ? hook(line) : line])
    },
  }
  return { members, grants: grantStore({ db, hook }), audit, settings: settingStore({ db, hashKey, members, hook }) }
}
