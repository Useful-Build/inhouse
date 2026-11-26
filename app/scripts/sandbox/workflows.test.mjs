// The trust rules of the sandbox test deploy's workflows, held by test (as the ops repo's scripts/workflows.test.mjs
// holds its own). Ways they could break, written down first:
//  1. a job that holds CF_SANDBOX_TOKEN runs the PR's code: checks the PR out (a `ref:` or `repository:` on a checkout),
//     runs a package script (`npm run`, `npx`, a plain `npm ci` or `npm install`), or loses the main tripwire;
//  2. it takes the PR's build some other way than deploy-config.mjs's exact file list, or deploys before the lock;
//  3. a job that runs the PR's code gets the `sandbox` environment, a token permission beyond reading this run's jobs,
//     or a secret beyond SBX_ZONE (masking only);
//  4. the token reaches another job or workflow, or the deploy workflow gains a trigger a branch or a fork controls;
//  5. a job that holds a secret restores an Actions cache the PR's code could have written (pr-code runs on main);
//  6. an action is pinned by tag, not by commit.
// SECRET_JOBS freezes each secret job, and the deploy workflow's header, as text (secret-jobs/*.yml): changing one means changing its copy
// here in the same PR, so a reviewer sees the change twice. Oracle: the workflow files, read as text by indentation
// (two-space YAML, as every workflow here is written).
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const WORKFLOWS = new URL('../../../.github/workflows/', import.meta.url)
const read = name => readFileSync(new URL(name, WORKFLOWS), 'utf8')
const DEPLOY = 'sandbox-test-deploy.yml'
const CLEANUP = 'sandbox-test-deploy-cleanup.yml'

/** The workflow's text before `jobs:`, and each job's text (its own lines, from `  <id>:` to the next job). */
function split(text) {
  const lines = text.split('\n')
  const at = lines.indexOf('jobs:')
  if (at < 0) throw new Error('no jobs: line')
  const jobs = {}
  let id = null
  for (const line of lines.slice(at + 1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (m) { id = m[1]; jobs[id] = [] }
    if (id) jobs[id].push(line)
  }
  return { header: lines.slice(0, at).join('\n').trimEnd(), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n').trimEnd()])) }
}
/** The `run:` and `with:` text of each step, as one string per step, in order. */
const steps = job => job.split(/\n(?= {6}- )/).slice(1)

// The frozen copies, in secret-jobs/ beside this test. Change one only together with a reviewed change to the job itself.
const frozen = name => readFileSync(new URL(`secret-jobs/${name}`, import.meta.url), 'utf8').trimEnd()
const SECRET_JOBS = {
  [`${DEPLOY}#deploy`]: frozen('sandbox-test-deploy.deploy.yml'),
  [`${CLEANUP}#cleanup`]: frozen('sandbox-test-deploy-cleanup.cleanup.yml'),
}
const DEPLOY_HEADER = frozen('sandbox-test-deploy.header.yml')

describe('secret jobs are frozen (failures 1 to 4)', () => {
  test('each secret job is exactly its frozen copy', () => {
    for (const [key, frozen] of Object.entries(SECRET_JOBS)) {
      const [file, id] = key.split('#')
      expect(split(read(file)).jobs[id], key).toBe(frozen)
    }
  })
  test('the deploy workflow\'s header (its triggers, top permissions, defaults, env) is exactly its frozen copy', () => {
    expect(split(read(DEPLOY)).header).toBe(DEPLOY_HEADER)
  })
})

describe('the rules, whatever the copies say', () => {
  const all = readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).map(f => ({ file: f, ...split(read(f)) }))
  const tokenJobs = all.flatMap(w => Object.entries(w.jobs).filter(([, t]) => t.includes('secrets.CF_SANDBOX_TOKEN')).map(([id, text]) => ({ key: `${w.file}#${id}`, text })))

  test('only the frozen jobs hold the token (failure 4)', () => {
    expect(tokenJobs.map(j => j.key).sort()).toEqual(Object.keys(SECRET_JOBS).sort())
  })
  test('a token job runs only main\'s code, behind the main tripwire (failures 1, 2)', () => {
    for (const { key, text } of tokenJobs) {
      expect(text, key).toMatch(/\n {4}environment: sandbox\n/)
      const first = steps(text)[0]
      expect(first, `${key}: the first step is the main tripwire`).toContain('[ "$REF" = refs/heads/main ] ||')
      for (const step of steps(text).filter(s => s.includes('actions/checkout@'))) {
        expect(step, key).not.toMatch(/\n\s+repository:/)
        const ref = /\n\s+ref:\s*(.*)/.exec(step)?.[1]
        if (ref !== undefined) expect(ref, key).toBe('${{ github.sha }}')
        expect(step, key).toContain('persist-credentials: false')
      }
      expect(text, key).not.toMatch(/\bnpm run\b|\bnpx\b|\bnpm (install|i)\b|\byarn\b|\bpnpm\b/)
      for (const m of text.matchAll(/\bnpm ci\b[^\n]*/g)) expect(m[0], key).toContain('--ignore-scripts')
      expect(text, key).not.toContain('needs.pr-code.outputs')
    }
  })
  test('the deploy takes the build only through deploy-config.mjs and the lock, before deploy.mjs (failure 2)', () => {
    const deploy = split(read(DEPLOY)).jobs.deploy
    const order = ['scripts/sandbox/deploy-config.mjs', 'check-product-config.mjs --sandbox --per-pr', 'scripts/sandbox/deploy.mjs']
    const at = order.map(s => deploy.indexOf(s))
    expect(at.every(i => i > 0), JSON.stringify(at)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(deploy).toContain('--artifact "$RUNNER_TEMP/artifact"')
  })
  test('pr-code: no environment, only actions and contents read, no secret but SBX_ZONE (failure 3)', () => {
    const job = split(read(DEPLOY)).jobs['pr-code']
    expect(job).not.toMatch(/\benvironment:/)
    expect(/\n {4}permissions:\n((?: {6}.*\n)+)/.exec(`${job}\n`)?.[1].split('\n').map(l => l.trim()).filter(Boolean).sort()).toEqual(['actions: read', 'contents: read'])
    expect([...new Set(job.match(/secrets\.[A-Za-z0-9_]+/g))]).toEqual(['secrets.SBX_ZONE'])
    const check = split(read(DEPLOY)).jobs.check
    expect(check).not.toMatch(/secrets\.|\benvironment:/)
  })
  test('the deploy workflow starts only by dispatch; the cleanup only on a PR close, a schedule or dispatch (failure 4)', () => {
    const on = h => /\non:\n((?: {2}.*\n|\n)+?)(?=\S)/.exec(`${h}\n`)?.[1] ?? ''
    expect(on(split(read(DEPLOY)).header).match(/^ {2}[a-z_]+:/gm)).toEqual(['  workflow_dispatch:'])
    expect(on(split(read(CLEANUP)).header).match(/^ {2}[a-z_]+:/gm)).toEqual(['  pull_request_target:', '  schedule:', '  workflow_dispatch:'])
    expect(read(CLEANUP)).toMatch(/pull_request_target:\n {4}types: \[closed\]\n(?: {4}#.*\n)* {4}branches: \[main\]\n/)
  })
  // setup-node turns its npm cache on by itself only for a package.json with a packageManager field (AGENTS.md: add
  // package-manager-cache: false everywhere before adding one), or with `cache:` set.
  test('no workflow restores an Actions cache or sets cache:; the sandbox secret jobs turn setup-node\'s cache off (failure 5)', () => {
    for (const w of all) {
      const text = read(w.file)
      expect(text, w.file).not.toMatch(/uses:\s*actions\/cache[@/]/)
      for (const [id, job] of Object.entries(w.jobs)) {
        for (const step of steps(job).filter(s => s.includes('actions/setup-node@'))) {
          expect(step, `${w.file}#${id}`).not.toMatch(/\n\s+cache:/)
          if ([DEPLOY, CLEANUP].includes(w.file) && /secrets\./.test(job)) expect(step, `${w.file}#${id}`).toContain('package-manager-cache: false')
        }
      }
    }
    for (const pkg of ['../../package.json', '../../hub/package.json', '../../runner/package.json']) {
      const json = JSON.parse(readFileSync(new URL(pkg, import.meta.url), 'utf8'))
      expect(json.packageManager, pkg).toBeUndefined()
      expect(json.devEngines?.packageManager, pkg).toBeUndefined()
    }
  })
  test('every action is pinned to a commit (failure 6)', () => {
    for (const w of all) {
      for (const m of read(w.file).matchAll(/uses:\s*([^\s#]+)/g)) {
        if (m[1].startsWith('./')) continue
        expect(m[1], w.file).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/)
      }
    }
  })
})
