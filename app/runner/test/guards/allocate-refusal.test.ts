// A failed allocate answers before the run's stream starts: a typed refusal the Worker can route on for the pool's
// two known refusals, a 500 for anything else. Ways it could fail, written first:
// - a full pool or a parked folder comes back as the generic 500, so the Worker can't tell "try later" from a fault;
// - any other error (one with some other `code`, a thrown non-Error) is passed off as one of the two refusals;
// - the refusal comes after the stream's headers (a 200 with a failed event) or a session is spawned anyway;
// - the error's own message (which can name a chat id) reaches the body.
import type { AddressInfo } from 'node:net'
import { fc, it } from '@fast-check/vitest'
import { afterEach, describe, expect } from 'vitest'
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../../../shared/protocol/index.ts'
import { SessionFolderParkedError, SessionPoolExhaustedError } from '../../src/guards/users.ts'
import { createRoot, type Root } from '../../src/server/app.ts'
import type { SessionUsers } from '../../src/session/seam.ts'
import { runStart } from '../run/support/root-client.ts'

let open: Root | null = null
afterEach(async () => {
  await open?.stopAll()
  open?.server.close()
  open = null
})

async function startWith(failure: () => unknown) {
  const spawned: string[] = []
  const users: SessionUsers = {
    kind: 'test',
    allocate: async () => {
      throw failure()
    },
    release: async () => {},
    quarantined: () => 0,
  }
  const root = createRoot({
    users,
    spawnSession: (user) => {
      spawned.push(user.user)
      throw new Error('never spawned')
    },
    proxyPort: 9,
    stopGraceMs: 1000,
    runTimeoutMs: 60_000,
    memory: () => ({ totalBytes: null, availableBytes: null, rssBytes: 1, heapUsedBytes: 1 }),
    apiPeerAllowed: async () => true,
    log: () => {},
  })
  open = root
  await new Promise<void>((r) => root.server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(root.server.address() as AddressInfo).port}`
  const res = await fetch(`${url}/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
    body: JSON.stringify(runStart({ chatId: 'chat-secret-name' })),
  })
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text(), spawned, live: root.liveCount() }
}

describe('a failed allocate', () => {
  it.each([
    ['the pool is full', () => new SessionPoolExhaustedError('all 64 session users are busy (chat-secret-name)'), 'session_pool_exhausted'],
    ["the chat's folder is parked for good", () => new SessionFolderParkedError('the folder of session chat-secret-name is parked'), 'session_folder_parked'],
  ])('%s: 503 with the code, before any stream, and no session', async (_, failure, code) => {
    const r = await startWith(failure)
    expect(r.status).toBe(503)
    expect(r.type).toBe('application/json')
    expect(JSON.parse(r.body)).toEqual({ error: code })
    expect(r.body).not.toContain('chat-secret-name')
    expect(r.spawned).toEqual([])
    expect(r.live).toBe(0)
  })

  const otherCode = fc.oneof(fc.string(), fc.integer(), fc.constant(undefined), fc.constant(null)).filter((c) => c !== 'session_pool_exhausted' && c !== 'session_folder_parked')
  it.prop([
    fc.oneof(
      otherCode.map((code) => () => Object.assign(new Error('boom chat-secret-name'), { code })),
      fc.constantFrom<() => unknown>(() => 'a string', () => null, () => undefined, () => 42, () => ({ code: { toString: () => 'session_pool_exhausted' } })),
    ),
  ])('any other failure: the generic 500', async (failure) => {
    const r = await startWith(failure)
    expect(r.status).toBe(500)
    expect(JSON.parse(r.body)).toEqual({ error: 'could not set up the session user' })
    expect(r.spawned).toEqual([])
    await open?.stopAll()
    open?.server.close()
    open = null
  })
})
