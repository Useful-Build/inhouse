// The image's entrypoint (image/bin/entrypoint.sh), run as a script with its paths pointed at temp folders. Ways it
// could fail, written first: with the intercept CA there, NODE_EXTRA_CA_CERTS isn't set for the root (and so not for
// the sessions), or the CA isn't copied into the trust store folder; without it, the runner doesn't start, or starts
// with a CA variable naming a missing file; the command it's given isn't the one run.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../image/bin/entrypoint.sh', import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'entrypoint-'))
  dirs.push(d)
  return d
}
/** Runs the entrypoint with `node -e` printing what the started process sees. */
function run(env: Record<string, string>) {
  const out = execFileSync('/bin/sh', [SCRIPT, process.execPath, '-e', 'console.log(JSON.stringify({ ca: process.env.NODE_EXTRA_CA_CERTS ?? null }))'], {
    env: { PATH: process.env.PATH!, INHOUSE_CA_WAIT_SECONDS: '0', ...env },
    encoding: 'utf8',
  })
  return out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe('the entrypoint', () => {
  it('with the CA: NODE_EXTRA_CA_CERTS names it for the command it starts, and it says so once', () => {
    const d = temp()
    const ca = join(d, 'cloudflare-containers-ca.crt')
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n')
    const lines = run({ INHOUSE_CA_FILE: ca, INHOUSE_CA_TRUST_DIR: join(d, 'trust') })
    expect(lines[0]).toMatchObject({ type: 'intercept_ca', found: true })
    expect(lines[1]).toEqual({ ca })
    expect(lines).toHaveLength(2)
  })

  it('with the CA and a trust store tool on PATH: the CA is copied into the trust folder', () => {
    const d = temp()
    const ca = join(d, 'ca.crt')
    writeFileSync(ca, 'pem')
    const trust = join(d, 'trust')
    const bin = join(d, 'bin')
    execFileSync('/bin/mkdir', ['-p', trust, bin])
    // A stand-in for update-ca-certificates that records it ran.
    writeFileSync(join(bin, 'update-ca-certificates'), `#!/bin/sh\ntouch ${join(d, 'updated')}\n`, { mode: 0o755 })
    const lines = run({ INHOUSE_CA_FILE: ca, INHOUSE_CA_TRUST_DIR: trust, PATH: `${bin}:${process.env.PATH}` })
    expect(lines[0]).toEqual({ type: 'intercept_ca', found: true, systemStore: 'system' })
    expect(readFileSync(join(trust, 'cloudflare-containers-ca.crt'), 'utf8')).toBe('pem')
    expect(existsSync(join(d, 'updated'))).toBe(true)
  })

  it('without the CA: logged once, no CA variable, and the command still runs', () => {
    const d = temp()
    const lines = run({ INHOUSE_CA_FILE: join(d, 'absent.crt'), INHOUSE_CA_TRUST_DIR: join(d, 'trust') })
    expect(lines).toEqual([{ type: 'intercept_ca', found: false }, { ca: null }])
  })
})
