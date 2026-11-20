// The ways the product build could break the demo's deploy redirect, each on a temp folder:
//   - a product build that wrote its pointer leaves the demo's pointer (or no file) behind it;
//   - a demo pointer written after the product's is never clobbered or removed;
//   - a build killed by SIGTERM restores before it dies, and still dies by the signal;
//   - a failed product build that wrote nothing changes nothing;
//   - a stale product pointer in the snapshot is never put back;
//   - a demo pointer sandwiched between the snapshot and the product's write is lost, but never replaced by the
//     product's (documented limit: demo and product builds must not run at the same time).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pointsInto, restoreRedirect, snapshotRedirect } from './demo-deploy-redirect.ts'

const DEMO = '{"configPath":"../../dist/inhouse_app/wrangler.json","auxiliaryWorkers":[]}'
const DEMO_LATER = '{"configPath":"../../dist/inhouse_app/wrangler.json","auxiliaryWorkers":[],"later":true}'
const PRODUCT = '{"configPath":"../../dist-product/inhouse_app/wrangler.json","auxiliaryWorkers":[]}'

let dir: string
let file: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'redirect-')); file = join(dir, 'config.json') })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const read = () => (existsSync(file) ? readFileSync(file, 'utf8') : null)

describe('pointsInto', () => {
  it('matches the folder as a path segment only', () => {
    expect(pointsInto(PRODUCT, 'dist-product')).toBe(true)
    expect(pointsInto(DEMO, 'dist-product')).toBe(false)
    expect(pointsInto('{"configPath":"../../dist-product-old/x.json"}', 'dist-product')).toBe(false)
    expect(pointsInto('{"configPath":"..\\\\..\\\\dist-product\\\\x.json"}', 'dist-product')).toBe(true)
    expect(pointsInto('not json', 'dist-product')).toBe(false)
    expect(pointsInto('{}', 'dist-product')).toBe(false)
  })
})

describe('restoreRedirect', () => {
  it('puts the demo pointer back after a product build wrote its own', () => {
    writeFileSync(file, DEMO)
    const snap = snapshotRedirect(file)
    writeFileSync(file, PRODUCT)
    expect(restoreRedirect(snap, 'dist-product')).toBe('restored')
    expect(read()).toBe(DEMO)
  })

  it('removes the product pointer when there was none before', () => {
    const snap = snapshotRedirect(file)
    writeFileSync(file, PRODUCT)
    expect(restoreRedirect(snap, 'dist-product')).toBe('removed')
    expect(read()).toBeNull()
  })

  it('leaves a demo pointer written after the snapshot or after the product\'s', () => {
    const none = snapshotRedirect(file)
    writeFileSync(file, DEMO_LATER)
    expect(restoreRedirect(none, 'dist-product')).toBe('left')
    expect(read()).toBe(DEMO_LATER)

    writeFileSync(file, DEMO)
    const snap = snapshotRedirect(file)
    writeFileSync(file, PRODUCT)
    writeFileSync(file, DEMO_LATER) // the demo build finished last
    expect(restoreRedirect(snap, 'dist-product')).toBe('left')
    expect(read()).toBe(DEMO_LATER)
  })

  it('never leaves the product pointer when a demo write is sandwiched before the product write', () => {
    const none = snapshotRedirect(file)
    writeFileSync(file, DEMO) // the demo build wrote between the snapshot and the product's write
    writeFileSync(file, PRODUCT)
    expect(restoreRedirect(none, 'dist-product')).toBe('removed') // preview then fails loud, never serves the product
    expect(read()).toBeNull()
  })

  it('changes nothing when the product build wrote nothing (a failed build)', () => {
    writeFileSync(file, DEMO)
    expect(restoreRedirect(snapshotRedirect(file), 'dist-product')).toBe('left')
    expect(read()).toBe(DEMO)
    rmSync(file)
    expect(restoreRedirect(snapshotRedirect(file), 'dist-product')).toBe('left')
    expect(read()).toBeNull()
  })

  it('never puts back a stale product pointer from the snapshot', () => {
    writeFileSync(file, PRODUCT)
    const snap = snapshotRedirect(file)
    expect(restoreRedirect(snap, 'dist-product')).toBe('removed')
    expect(read()).toBeNull()
  })

  it('is safe to run twice (after buildApp, then on exit)', () => {
    writeFileSync(file, DEMO)
    const snap = snapshotRedirect(file)
    writeFileSync(file, PRODUCT)
    expect(restoreRedirect(snap, 'dist-product')).toBe('restored')
    expect(restoreRedirect(snap, 'dist-product')).toBe('left')
    expect(read()).toBe(DEMO)
  })
})

describe('restoreOnAnyEnd', () => {
  const helper = fileURLToPath(new URL('./demo-deploy-redirect.ts', import.meta.url))
  // A child process registers the restore, writes the product pointer, then is killed by SIGTERM (or exits).
  const run = (end: 'SIGTERM' | 'exit') => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs'
    import { restoreOnAnyEnd, restoreRedirect, snapshotRedirect } from ${JSON.stringify(helper)}
    const snap = snapshotRedirect(${JSON.stringify(file)})
    restoreOnAnyEnd(() => restoreRedirect(snap, 'dist-product'))
    writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(PRODUCT)})
    ${end === 'SIGTERM' ? "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)" : ''}
  `], { encoding: 'utf8' })

  it('restores on SIGTERM and the process still ends by the signal', () => {
    writeFileSync(file, DEMO)
    const r = run('SIGTERM')
    expect(r.signal).toBe('SIGTERM')
    expect(read()).toBe(DEMO)
  })

  it('restores on a normal exit', () => {
    writeFileSync(file, DEMO)
    const r = run('exit')
    expect(r.status).toBe(0)
    expect(read()).toBe(DEMO)
  })
})
