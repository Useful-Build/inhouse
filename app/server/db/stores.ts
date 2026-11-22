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
import { all, first, runBatch, stmt } from './sql.ts'
import { settingStore } from './settings.ts'
import type { SettingStore } from './settings.ts'
// P3's slots (p3-design section 12): one per owner, each in the owner's own file.
import { chatStore } from './chats.ts'
import type { ChatStore } from './chats.ts'

import { fileStore } from '../files-io/store.ts'
import type { FileStore } from '../files-io/store.ts'

import { usageStore } from '../usage/store.ts'
import type { UsageStore } from '../usage/store.ts'

import { memoryStore } from '../mcp/tools/memory/store.ts'
import type { MemoryStore } from '../mcp/tools/memory/store.ts'

// P4's slots, one per owner.
import { activityReader } from '../activity/read.ts'
import type { ActivityReader } from '../activity/read.ts'
import { noticeReader } from '../notices/read.ts'
import type { NoticeReader } from '../notices/read.ts'
import { libraryStore } from '../files/store.ts'
import type { LibraryStore } from '../files/store.ts'

import { todayStore } from '../today/store.ts'
import type { TodayStore } from '../today/store.ts'

import { routineStore } from '../routines/store.ts'
import type { RoutineStore } from '../routines/store.ts'
import { teamRequestStore } from '../team-requests/store.ts'
import type { TeamRequestStore } from '../team-requests/store.ts'

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
    /** The names of every migration applied (wrangler's `d1_migrations`), without `.sql`, in no particular order. */
    appliedMigrations(): Promise<string[]>
  }

  // P3's slots, one per owner (blank-line separated: each owner edits only its own line and its own file).
  /** W1 (p3-w1.md): chats and their messages. */
  chats: ChatStore

  /** W3 (p3-w3.md): chat files. */
  files: FileStore

  /** W4 (p3-w4.md): usage, the cap and the audit copy. */
  usage: UsageStore

  /** W6 (p3-w6.md): memory. */
  memory: MemoryStore

  /** P4 W4 (p4-w4.md): Activity's lines and the bell's notices and read state (the writers are `recordActivity` and `addNotice`). */
  activity: ActivityReader
  notices: NoticeReader

  /** P4 W3 (p4-w3.md section 5): Today's read and the set-aside write. */
  today: TodayStore

  /** P4 W2 (p4-w2.md sections 9 to 11): routes 33 and 52 to 56, and the routines signal's read. */
  routines: RoutineStore

  /** P4 W5 (p4-w5.md): the Library's uploads, marks and listed files. */
  library: LibraryStore

  /** P6a W3: requests to the Inhouse team (routes 80 to 83 and the `team_request_*` tools). */
  teamRequests: TeamRequestStore
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
        // The schema checks the pair (GET with a read route, PUT or POST with a write route Inhouse may use) and throws otherwise.
        args: { action: 'support.access', grantId: principal.grant.id, method: at.method as 'GET' | 'PUT' | 'POST', route: at.route as '/api/members' },
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
      async appliedMigrations() {
        return (await all<{ name: string }>(db, stmt('SELECT name FROM d1_migrations'))).map(r => r.name.replace(/\.sql$/, ''))
      },
    },

    // P3's slots, one per owner.
    chats: chatStore({ db }),

    files: fileStore({ db, bucket: env.FILES }),

    usage: usageStore({ db }),

    memory: memoryStore({ db }),

    // P4's slots.
    activity: activityReader({ db }),
    notices: noticeReader({ db }),

    today: todayStore({ db, hook }),

    routines: routineStore({ db }),

    library: libraryStore({ db, bucket: env.FILES }),

    teamRequests: teamRequestStore({ db }),
  }
}
