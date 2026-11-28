// The doors' resilience (#689, #690, #691), ways it could fail, written first:
//  - one transient error (a reset, a 5xx, a 429, a timeout) on a read ends a 6-hour run;
//  - a retry hides a permanent error (an auth refusal, a bad config) or repeats a write that may have landed;
//  - a retry is silent: the report never says the run leaned on one;
//  - the 120 s kill stops npx but not the wrangler under it, which lands its SQL after the lease went back;
//  - the product target's progress counter misses calls, so a close gives up on a setup that is still moving.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DoorRefusal, readOnlySql, spawnWrangler, wranglerRunner, wranglerTransient, type WranglerResult } from './door.ts'
import { TransientDoorError, withRetries } from './retry.ts'
import { createSessionReader } from '../read-side/product/r2.ts'
import { createProductTarget } from './product.ts'

const noWait = { sleep: async () => {} }

describe('#691: a transient door error retries, a permanent one stops at once', () => {
  it('withRetries: a transient error that recovers is retried and reported; a permanent one is thrown on the first try', async () => {
    const lines: string[] = []
    let tries = 0
    const ok = await withRetries('a read', async () => {
      if (++tries < 3) throw new TransientDoorError('a 5xx from the API', new DoorRefusal('answered 503'))
      return 'rows'
    }, { ...noWait, onRetry: (l) => lines.push(l) })
    expect(ok).toBe('rows')
    expect(lines).toEqual(['A door read was retried: a read (a 5xx from the API), try 2 of 4.', 'A door read was retried: a read (a 5xx from the API), try 3 of 4.'])
    tries = 0
    await expect(withRetries('a read', async () => { tries++; throw new DoorRefusal('answered 403') }, { ...noWait, onRetry: (l) => lines.push(l) })).rejects.toThrow('answered 403')
    expect(tries).toBe(1)
    // Still transient on the last try: its own error, after 4 tries in all.
    tries = 0
    await expect(withRetries('a read', async () => { tries++; throw new TransientDoorError('a timeout', new DoorRefusal('did not end')) }, { ...noWait, onRetry: () => {} })).rejects.toThrow(new DoorRefusal('did not end'))
    expect(tries).toBe(4)
  })

  const runner = (results: WranglerResult[], lines: string[], argv: string[][] = []) => wranglerRunner({
    database: 'inhouse-sbx-eval-db', config: 'c', env: { CF_SANDBOX_ACCOUNT_ID: 'acct' },
    readConfig: () => JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: 'inhouse-sbx-eval-db' }] }),
    spawn: (a) => { argv.push(a); return results.shift() ?? { status: 0, stdout: '[{"results":[{"n":1}]}]' } },
    retry: { ...noWait, onRetry: (l) => lines.push(l) },
  })

  it('a D1 read through wrangler: a 5xx, a reset or a timeout retries and recovers; each retry is a line', async () => {
    const lines: string[] = []
    const run = runner([{ status: 1, stdout: '', output: 'A request to the Cloudflare API failed: 503 Service Unavailable' }, { status: 1, stdout: '', output: 'TypeError: fetch failed (ECONNRESET)' }, { status: null, stdout: '' }], lines)
    expect(await run('SELECT 1 AS n')).toEqual([{ n: 1 }])
    expect(lines).toEqual([
      'A door read was retried: a D1 read through wrangler (a 5xx from the API), try 2 of 4.',
      'A door read was retried: a D1 read through wrangler (a network error), try 3 of 4.',
      'A door read was retried: a D1 read through wrangler (a timeout), try 4 of 4.',
    ])
  })

  it('an auth refusal, an unknown failure or a write never retries: the first error stops it', async () => {
    const lines: string[] = []
    const argv: string[][] = []
    // A 403 stops at once, even when the output also reads like a 5xx.
    await expect(runner([{ status: 1, stdout: '', output: 'Authentication error [code: 10000] 403 (and a 503 before it)' }], lines, argv)('SELECT 1')).rejects.toThrow('wrangler d1 execute exited 1')
    await expect(runner([{ status: 1, stdout: '', output: 'no such table: memories' }], lines, argv)('SELECT 1')).rejects.toThrow('wrangler d1 execute exited 1')
    // A write that timed out or met a 5xx may have landed: never sent again.
    await expect(runner([{ status: null, stdout: '' }], lines, argv)("INSERT INTO t VALUES (1)")).rejects.toThrow(/did not end/)
    await expect(runner([{ status: 1, stdout: '', output: '503 Service Unavailable' }], lines, argv)('SELECT 1; DELETE FROM t')).rejects.toThrow('exited 1')
    expect(argv).toHaveLength(4)
    expect(lines).toEqual([])
  })

  it('reads are one SELECT only; the labels never carry the output', () => {
    expect(readOnlySql('  select * from t')).toBe(true)
    expect(readOnlySql('SELECT 1;')).toBe(true)
    expect(readOnlySql('SELECT 1; DELETE FROM t')).toBe(false)
    expect(readOnlySql('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(false)
    expect(readOnlySql('UPDATE t SET a = 1')).toBe(false)
    expect(wranglerTransient({ status: 1, stdout: '', output: 'secret-host 429 Too Many Requests' })).toBe('a 429 from the API')
    expect(wranglerTransient({ status: 1, stdout: '', output: 'Unauthorized' })).toBeNull()
  })

  const ACCOUNT = '0123456789abcdef0123456789abcdef'
  const env = { CF_SANDBOX_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'tok-secret-1' }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('an R2 list: a 503, a 429 or a network error retries and recovers; a 403 stops at once', async () => {
    const lines: string[] = []
    const answers: (() => Response)[] = [() => json(503, {}), () => { throw new TypeError('fetch failed') }, () => json(429, {})]
    let calls = 0
    const reader = (more: (() => Response)[]) => createSessionReader({ env, bucket: 'inhouse-sbx-eval-files', retry: { ...noWait, onRetry: (l) => lines.push(l) }, fetch: (async () => { calls++; return (more.shift() ?? (() => json(200, { success: true, result: [] })))() }) as unknown as typeof fetch })
    await reader(answers).preflight()
    expect(calls).toBe(4)
    expect(lines).toEqual([
      'A door read was retried: an R2 preflight (a 5xx from R2), try 2 of 4.',
      'A door read was retried: an R2 preflight (a network error), try 3 of 4.',
      'A door read was retried: an R2 preflight (a 429 from R2), try 4 of 4.',
    ])
    calls = 0
    lines.length = 0
    await expect(reader([() => json(403, {})]).preflight()).rejects.toThrow(/answered 403: CLOUDFLARE_API_TOKEN lacks R2 read/)
    expect(calls).toBe(1)
    // A 5xx on every try: the status is named as before, after 4 tries.
    calls = 0
    await expect(reader([() => json(502, {}), () => json(502, {}), () => json(502, {}), () => json(502, {})]).preflight()).rejects.toThrow('R2 preflight answered 502')
    expect(calls).toBe(4)
    expect(lines.join('\n')).not.toContain('tok-secret-1')
  })
})

describe('#690: the deadline kills the whole process group', () => {
  // A stand-in for `npx wrangler`: a shell that starts a long-lived child (as npx starts wrangler), writes its pid, waits.
  const stub = (body: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wrangler-stub-'))
    const bin = path.join(dir, 'wrangler')
    writeFileSync(bin, `#!/bin/sh\n${body}\n`)
    chmodSync(bin, 0o755)
    return { bin, pidFile: path.join(dir, 'child.pid') }
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const gone = async (pid: number) => {
    const deadline = Date.now() + 5_000
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    return !alive(pid)
  }

  it('a call past its deadline: the leader and the child under it are both killed, and its status is null', async () => {
    const { bin, pidFile } = stub('sleep 30 &\necho $! > "$PIDFILE"\nwait')
    const r = await spawnWrangler(['d1', 'execute'], { PATH: process.env.PATH, PIDFILE: pidFile }, { bin: [bin], timeoutMs: 300 })
    expect(r).toMatchObject({ status: null, timedOut: true })
    const child = Number(readFileSync(pidFile, 'utf8'))
    expect(child).toBeGreaterThan(0)
    expect(await gone(child)).toBe(true)
  })

  it('a command that can\'t start is a refusal, not a retry', async () => {
    await expect(spawnWrangler([], { PATH: process.env.PATH }, { bin: [path.join(tmpdir(), 'no-such-wrangler-bin')] })).rejects.toThrow(new DoorRefusal('wrangler could not start (ENOENT)'))
  })

  it('a call that ends: its answer comes back, and a child it left in its group is killed too', async () => {
    const { bin, pidFile } = stub('sleep 30 > /dev/null 2>&1 &\necho $! > "$PIDFILE"\necho \'[{"results":[]}]\'')
    const r = await spawnWrangler(['d1', 'execute'], { PATH: process.env.PATH, PIDFILE: pidFile }, { bin: [bin], timeoutMs: 10_000 })
    expect(r).toMatchObject({ status: 0, stdout: '[{"results":[]}]\n', timedOut: false })
    expect(await gone(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  })
})

describe('#689: the product target counts every call it ends', () => {
  it('a call that answers and one that fails both count', async () => {
    let fail = false
    const t = createProductTarget({
      paid: true, budgetUsd: 1, signIn: async () => ({}),
      env: { INHOUSE_EVAL_BRAND: '1', INHOUSE_EVAL_RUN: '1-1', INHOUSE_EVAL_ORIGIN: 'https://eval.example', INHOUSE_EVAL_ACCESS_CLIENT_ID: 'id', INHOUSE_EVAL_ACCESS_CLIENT_SECRET: 's' },
      fetch: (async () => { if (fail) throw new TypeError('fetch failed'); return new Response('{}') }) as typeof fetch,
    })
    expect(t.progress!()).toBe(0)
    await t.call('lena', 'GET', '/api/me')
    expect(t.progress!()).toBe(1)
    fail = true
    await expect(t.call('lena', 'GET', '/api/me')).rejects.toThrow('fetch failed')
    expect(t.progress!()).toBe(2)
  })
})
