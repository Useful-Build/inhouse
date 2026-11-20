// The stores' construction in the API's path. Ways it can fail, written down first:
//  1. a Worker without AUDIT_HASH_KEY answers something other than 503, or logs an unnamed error (the cause is lost);
//  2. the log line carries the key's value or anything but the error's name.
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api.ts'
import type { ApiParts } from '../api.ts'
import { authenticate, checkAccess, checkOrigin } from '../auth/index.ts'
import { openStores } from './stores.ts'

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext

afterEach(() => vi.restoreAllMocks())

describe('AUDIT_HASH_KEY unset', () => {
  it('answers 503 and logs AuditKeyMissingError by name (failures 1, 2)', async () => {
    const logged: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args))
    const parts: ApiParts = { authenticate, checkOrigin, checkAccess, stores: e => openStores({ DB: e.DB, AUDIT_HASH_KEY: '' }), routes: [], accessMatrix: [] }
    const res = await api(parts, new Request('http://brand.localhost:8787/api/members'), env, ctx, 'req-key')
    expect(res.status).toBe(503)
    expect(logged).toEqual([[{ event: 'auth_store_failed', requestId: 'req-key', error: 'AuditKeyMissingError' }]])
  })
})
