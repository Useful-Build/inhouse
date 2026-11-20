// The D1 stores (W1's `AuthStores` and the members and settings routes' own), made once per request from the Worker's
// env (server/api.ts `ApiParts.stores`). Every method takes data and returns data: none hands out a statement, a
// batch or a sub-store (the store contract in server/routes.ts), so the stores close cleanly after an access refusal.
import type { AuditSink, AuthStores, GrantStore, MemberDirectory } from '../auth/stores.ts'
import { AuditKeyMissingError, auditInsert } from './audit.ts'
import type { AuditHook } from './audit.ts'
import { auditReader } from './audit-read.ts'
import type { AuditReader } from './audit-read.ts'
import { grantStore } from './grants.ts'
import type { GrantStoreImpl } from './grants.ts'
import { memberStore } from './members.ts'
import type { MemberStore } from './members.ts'
import { photoStore } from './photos.ts'
import type { PhotoStore, PhotoStoreDeps } from './photos.ts'
import { first, runBatch, stmt } from './sql.ts'
import { settingStore } from './settings.ts'
import type { SettingStore } from './settings.ts'

export interface Stores extends AuthStores {
  members: MemberDirectory & MemberStore
  grants: GrantStore & GrantStoreImpl
  audit: AuditSink & AuditReader
  settings: SettingStore
  photos: PhotoStore
  /** What the health route's signals read (server/ops/signals/core.ts). */
  health: {
    /** Throws when D1 can't answer `SELECT 1`. */
    ping(): Promise<void>
    /** The name of the last migration applied (wrangler's `d1_migrations`), or null when none is. */
    lastMigration(): Promise<string | null>
  }
}

/** What the stores read from the Worker's env. `AUDIT_HASH_KEY` is a secret on the product Worker (a var in the test build). */
export interface StoresEnv {
  DB: D1Database
  /** The R2 bucket of photos (wrangler config `FILES`). */
  FILES: PhotoStoreDeps['files']
  AUDIT_HASH_KEY?: string
}

/**
 * The stores over this env's D1. Throws when `AUDIT_HASH_KEY` is unset, so a Worker without it answers 503 instead of
 * logging a value it can't redact. `hook` and `testing` are for tests only (`hook` swaps every audit statement;
 * `testing.beforePhotoBatch` runs between a photo's R2 put and its D1 batch, `testing.afterPhotoBatch` right after it).
 */
export function openStores(env: StoresEnv, hook?: AuditHook, testing: { beforePhotoBatch?: () => Promise<void>; afterPhotoBatch?: () => Promise<void> } = {}): Stores {
  const hashKey = env.AUDIT_HASH_KEY
  if (!hashKey) throw new AuditKeyMissingError()
  const db = env.DB
  const members = memberStore({ db, hook })
  const audit: AuditSink & AuditReader = {
    ...auditReader({ db }),
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
  return {
    members,
    grants: grantStore({ db, hook }),
    audit,
    settings: settingStore({ db, hashKey, members, hook }),
    photos: photoStore({ db, files: env.FILES, hook, beforeBatch: testing.beforePhotoBatch, afterBatch: testing.afterPhotoBatch }),
    health: {
      async ping() {
        if ((await first<{ one: number }>(db, stmt('SELECT 1 AS one')))?.one !== 1) throw new Error('D1 did not answer SELECT 1')
      },
      async lastMigration() {
        return (await first<{ name: string }>(db, stmt('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')))?.name ?? null
      },
    },
  }
}
