// The doors' resilience (#689, #690, #691, #710, #711, #712), ways it could fail, written first:
//  - one transient error (a reset, a 5xx, a 429, a timeout) on a read ends a 6-hour run;
//  - the retry reads a status wrangler never prints (#710), so D1's own overloaded or reset answers still end the run;
//  - a retry hides a permanent error (an auth refusal, a SQL error) or repeats a write that may have landed;
//  - a retry is silent: the report never says the run leaned on one, nor does the close's progress check;
//  - the 120 s kill stops npx but not the wrangler under it, which lands its SQL after the lease went back;
//  - a hangup, or a SIGKILL to the run's group, leaves npx and wrangler running with no deadline (#711);
//  - two calls run at once, or a call outlives the run's exit (#712).
import { execFileSync, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DoorRefusal, oneAtATime, readOnlySql, spawnWrangler, wranglerRunner, wranglerTransient, type WranglerResult } from './door.ts'
import { TransientDoorError, withRetries } from './retry.ts'
import { createSessionReader } from '../read-side/product/r2.ts'
import { createProductTarget, doorSql } from './product.ts'
import { CANCEL_SIGNALS, listenForCancel } from '../injection/run.ts'

const noWait = { sleep: async () => {} }
const FIXTURES = path.join(import.meta.dirname, 'fixtures/wrangler-d1-errors')
/** A real `wrangler d1 execute --remote --json` failure (wrangler 4.162, captured by fixtures/wrangler-d1-errors/capture.mjs). */
const sample = (name: string): WranglerResult => {
  const text = readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8')
  const status = Number(/^exit (\d+)/.exec(text)![1])
  const stdout = text.split('--- stdout\n')[1]!.split('--- stderr\n')[0]!
  const stderr = text.split('--- stderr\n')[1] ?? ''
  return { status, stdout, output: `${stdout}\n${stderr}` }
}
const D1 = { database: 'inhouse-sbx-eval-db', config: 'c', env: { CF_SANDBOX_ACCOUNT_ID: 'acct' }, readConfig: () => JSON.stringify({ account_id: 'acct', d1_databases: [{ database_name: 'inhouse-sbx-eval-db' }] }) }
const OK: WranglerResult = { status: 0, stdout: '[{"results":[{"n":1}]}]' }

describe('#691 and #710: a transient door error retries, a permanent one stops at once', () => {
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
    tries = 0
    await expect(withRetries('a read', async () => { tries++; throw new TransientDoorError('a timeout', new DoorRefusal('did not end')) }, { ...noWait, onRetry: () => {} })).rejects.toThrow(new DoorRefusal('did not end'))
    expect(tries).toBe(4)
  })

  it('wrangler\'s real output for each transient API failure reads as transient (#710)', () => {
    expect(readdirSync(FIXTURES).filter((f) => f.endsWith('.txt')).length).toBe(13)
    expect(wranglerTransient(sample('d1-overloaded-queued'))).toBe('D1 overloaded')
    expect(wranglerTransient(sample('d1-overloaded-too-long'))).toBe('D1 overloaded')
    expect(wranglerTransient(sample('d1-network-lost'))).toBe('a transient D1 error')
    expect(wranglerTransient(sample('d1-reset-code-updated'))).toBe('a transient D1 error')
    expect(wranglerTransient(sample('d1-transient-remote-node'))).toBe('a transient D1 error')
    expect(wranglerTransient(sample('rate-limited-429'))).toBe('a 429 from the API')
    expect(wranglerTransient(sample('gateway-502-html'))).toBe('a 5xx from the API')
    expect(wranglerTransient(sample('connection-refused'))).toBe('a network error')
    expect(wranglerTransient({ status: null, stdout: '', timedOut: true })).toBe('a timeout')
  })

  it('wrangler\'s real output for an auth refusal, a missing database, a SQL error or a CPU limit is permanent (#710)', () => {
    for (const name of ['auth-10000', 'auth-7403', 'db-not-found-7404', 'sqlite-error', 'cpu-limit-reset']) expect([name, wranglerTransient(sample(name))]).toEqual([name, null])
    // An auth code wins over anything else in the same answer.
    const mixed = sample('d1-overloaded-queued')
    expect(wranglerTransient({ ...mixed, stdout: mixed.stdout.replace('"notes": [', '"notes": [\n      { "text": "Authentication error [code: 10000]" },') })).toBeNull()
    // A signal from outside (a cancel), or output that isn't wrangler's JSON: never retried.
    expect(wranglerTransient({ status: null, stdout: '' })).toBeNull()
    expect(wranglerTransient({ status: 1, stdout: 'Error: 503 Service Unavailable' })).toBeNull()
  })

  const runner = (results: WranglerResult[], lines: string[], argv: string[][] = []) => wranglerRunner({
    ...D1, spawn: (a) => { argv.push(a); return results.shift() ?? OK }, retry: { ...noWait, onRetry: (l) => lines.push(l) },
  })

  it('a D1 read through wrangler: D1 overloaded, a reset, a 429 and a refused connection retry and recover; each retry is a line', async () => {
    const lines: string[] = []
    const run = runner([sample('d1-overloaded-queued'), sample('d1-network-lost'), sample('rate-limited-429')], lines)
    expect(await run('SELECT 1 AS n')).toEqual([{ n: 1 }])
    expect(lines).toEqual([
      'A door read was retried: a D1 read through wrangler (D1 overloaded), try 2 of 4.',
      'A door read was retried: a D1 read through wrangler (a transient D1 error), try 3 of 4.',
      'A door read was retried: a D1 read through wrangler (a 429 from the API), try 4 of 4.',
    ])
    const again: string[] = []
    expect(await runner([sample('connection-refused'), { status: null, stdout: '', timedOut: true }], again)('SELECT 1 AS n')).toEqual([{ n: 1 }])
    expect(again.map((l) => /\((.*)\)/.exec(l)![1])).toEqual(['a network error', 'a timeout'])
  })

  it('an auth refusal, a SQL error or a write never retries: the first error stops it', async () => {
    const lines: string[] = []
    const argv: string[][] = []
    await expect(runner([sample('auth-10000')], lines, argv)('SELECT 1')).rejects.toThrow('wrangler d1 execute exited 1')
    await expect(runner([sample('sqlite-error')], lines, argv)('SELECT 1')).rejects.toThrow('wrangler d1 execute exited 1')
    // A write met by D1 overloaded, or that timed out, may have landed: never sent again.
    await expect(runner([sample('d1-overloaded-queued')], lines, argv)('INSERT INTO t VALUES (1)')).rejects.toThrow('exited 1')
    await expect(runner([{ status: null, stdout: '', timedOut: true }], lines, argv)('UPDATE t SET a = 1')).rejects.toThrow(/did not end/)
    await expect(runner([sample('d1-network-lost')], lines, argv)('SELECT 1; DELETE FROM t')).rejects.toThrow('exited 1')
    expect(argv).toHaveLength(5)
    expect(lines).toEqual([])
  })

  it('reads are one SELECT only', () => {
    expect(readOnlySql('  select * from t')).toBe(true)
    expect(readOnlySql('SELECT 1;')).toBe(true)
    expect(readOnlySql('SELECT 1; DELETE FROM t')).toBe(false)
    expect(readOnlySql('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')).toBe(false)
    expect(readOnlySql('UPDATE t SET a = 1')).toBe(false)
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
    calls = 0
    await expect(reader([() => json(502, {}), () => json(502, {}), () => json(502, {}), () => json(502, {})]).preflight()).rejects.toThrow('R2 preflight answered 502')
    expect(calls).toBe(4)
    expect(lines.join('\n')).not.toContain('tok-secret-1')
  })
})

describe('#712: one call at a time, and a retry is progress', () => {
  it('oneAtATime runs work in the order asked, one at a time, and goes on after a rejection (#714)', async () => {
    const log: string[] = []
    const job = (name: string, ms: number, fail = false) => () => new Promise<string>((resolve, reject) => {
      log.push(`start ${name}`)
      setTimeout(() => { log.push(`end ${name}`); if (fail) reject(new Error(name)); else resolve(name) }, ms)
    })
    const a = oneAtATime(job('a', 30))
    const b = oneAtATime(job('b', 5, true))
    const c = oneAtATime(job('c', 1))
    await expect(a).resolves.toBe('a')
    await expect(b).rejects.toThrow('b')
    await expect(c).resolves.toBe('c')
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
  })

  it('two reads asked for at once run one after the other, never together', async () => {
    let running = 0
    let most = 0
    const run = wranglerRunner({ ...D1, spawn: async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 10)); running--; return OK } })
    const other = wranglerRunner({ ...D1, spawn: async () => { running++; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 10)); running--; return OK } })
    await Promise.all([run('SELECT 1'), run('SELECT 2'), other('SELECT 3')])
    expect(most).toBe(1)
  })

  it('the product target\'s door runner: each retry of a read counts as progress and is reported; the call\'s end counts too', async () => {
    let progress = 0
    const lines: string[] = []
    const results = [sample('d1-overloaded-queued'), sample('d1-network-lost')]
    const sql = doorSql({ env: { INHOUSE_EVAL_D1_NAME: 'inhouse-sbx-eval-db', INHOUSE_EVAL_WRANGLER_CONFIG: 'c', CF_SANDBOX_ACCOUNT_ID: 'acct' }, readConfig: D1.readConfig, progress: () => { progress++ }, onRetry: (l) => lines.push(l), spawn: () => results.shift() ?? OK, ...noWait })
    expect(await sql('SELECT 1 AS n')).toEqual([{ n: 1 }])
    // Two retries and the call's end.
    expect(progress).toBe(3)
    expect(lines).toHaveLength(2)
  })
})

describe('#690 and #711: the deadline kills npx and everything under it; nothing outlives the run', () => {
  // A stand-in for `npx wrangler`: a shell that starts a long-lived child (as npx starts wrangler), writes its pid, waits.
  const stub = (body = 'sleep 30 &\necho $! > "$PIDFILE"\nwait') => {
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
    if (alive(pid)) {
      // Diagnosis for Linux CI (TEMPORARY): is the process running, or a zombie no one reaps? And is there a `ps`?
      let status = '(no /proc)'
      try { status = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').filter((l) => /^(Name|State|PPid):/.test(l)).join(' | ') } catch (e) { status = `(no /proc/${pid}/status: ${(e as Error).message.split('\n')[0]})` }
      let ps = ''
      try { ps = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).split('\n').length + ' ps lines' } catch (e) { ps = `ps failed: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message.split('\n')[0]}` }
      let init = ''
      try { init = readFileSync('/proc/1/cmdline', 'utf8').replaceAll('\0', ' ') } catch { init = '(unknown)' }
      console.error(`DIAG pid ${pid} still there: ${status}; ${ps}; pid 1 is: ${init}`)
    }
    return !alive(pid)
  }
  const childOf = (pidFile: string) => Number(readFileSync(pidFile, 'utf8'))
  /** The run in miniature (fixtures/wrangler-holder.ts), in its own process group, as a job runner starts one. */
  const holder = (bin: string, pidFile: string, mode: 'wait' | 'exit') => {
    const p = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures/wrangler-holder.ts'), bin, pidFile, mode], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
    const ready = new Promise<void>((resolve) => { p.stdout!.on('data', (d: Buffer) => { if (d.toString().includes('ready')) resolve() }) })
    const exited = new Promise<void>((resolve) => p.on('exit', () => resolve()))
    return { p, ready, exited }
  }

  it('a call past its deadline: npx and the child under it are both killed, and its status is null', async () => {
    const { bin, pidFile } = stub()
    const r = await spawnWrangler(['d1', 'execute'], { PATH: process.env.PATH, PIDFILE: pidFile }, { bin: [bin], timeoutMs: 2_000 })
    expect(r).toMatchObject({ status: null, timedOut: true })
    expect(await gone(childOf(pidFile))).toBe(true)
  })

  it('a command that can\'t start is a refusal, not a retry', async () => {
    await expect(spawnWrangler([], { PATH: process.env.PATH }, { bin: [path.join(tmpdir(), 'no-such-wrangler-bin')] })).rejects.toThrow(new DoorRefusal('wrangler could not start (ENOENT)'))
  })

  it('a call that ends: its answer comes back with its status', async () => {
    const { bin } = stub('echo \'[{"results":[]}]\'')
    expect(await spawnWrangler(['d1', 'execute'], { PATH: process.env.PATH }, { bin: [bin], timeoutMs: 10_000 })).toMatchObject({ status: 0, stdout: '[{"results":[]}]\n', timedOut: false })
  })

  it('a call that exits just before its deadline while its output is still open is its exit, never a false timeout (#713)', async () => {
    // The stub answers and exits at once; a child it leaves holds the output open past the 300 ms deadline.
    const { bin } = stub('sleep 1 &\necho \'[{"results":[]}]\'')
    const r = await spawnWrangler(['d1', 'execute'], { PATH: process.env.PATH }, { bin: [bin], timeoutMs: 300 })
    expect(r).toMatchObject({ status: 0, timedOut: false, stdout: '[{"results":[]}]\n' })
  })

  it('a SIGKILL to the run\'s whole process group takes the call\'s processes with it: no orphan (#711)', async () => {
    const { bin, pidFile } = stub()
    const h = holder(bin, pidFile, 'wait')
    await h.ready
    const child = childOf(pidFile)
    expect(alive(child)).toBe(true)
    process.kill(-h.p.pid!, 'SIGKILL')
    await h.exited
    expect(await gone(child)).toBe(true)
  })

  it('the run\'s exit with a call still running kills the call and the child under it (#712: the exit hook)', async () => {
    const { bin, pidFile } = stub()
    const h = holder(bin, pidFile, 'exit')
    await h.exited
    expect(await gone(childOf(pidFile))).toBe(true)
  })

  it('a hangup cancels the run like a Ctrl-C or a job stop, with its own exit code (#711)', () => {
    const proc = new EventEmitter()
    const got: [string, number][] = []
    listenForCancel((s, c) => got.push([s, c]), proc as unknown as NodeJS.Process)
    for (const s of ['SIGINT', 'SIGHUP', 'SIGTERM']) proc.emit(s)
    expect(got).toEqual([['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]])
    expect(CANCEL_SIGNALS.map(([s]) => s)).toContain('SIGHUP')
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
