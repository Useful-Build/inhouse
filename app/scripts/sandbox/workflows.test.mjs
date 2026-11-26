// The trust rules of the sandbox test deploy's workflows, held by test (as the ops repo's scripts/workflows.test.mjs
// holds its own). Ways they could break, written down first:
//  1. a job that can reach the sandbox token (the `sandbox` environment) runs the PR's code: checks the PR out (a `ref:`
//     or `repository:` on a checkout, a git checkout), runs a package script (`npm run`, `npx`, a plain `npm ci`), runs
//     the PR's image or a file from its artifact, or loses or neutralises the main tripwire;
//  2. it takes the PR's build some other way than deploy-config.mjs's exact file list, or deploys before the lock;
//  3. a job that runs the PR's code gets the `sandbox` environment, a token permission beyond reading contents and this
//     run's jobs, or a secret beyond SBX_ZONE (masking only), under any spelling (`secrets.x`, `secrets['X']`,
//     `toJSON(secrets)`, `secrets: inherit`);
//  4. another job or workflow (a new file included) names the `sandbox` environment, or the deploy workflow gains a
//     trigger a branch or a fork controls;
//  5. a job that holds a secret restores an Actions cache the PR's code could have written (pr-code runs on main);
//  6. an action is pinned by tag, not by commit.
// checkRules() reads every workflow file as text, by indentation (two-space YAML, as every workflow here is written),
// and refuses a job-level line it can't read. The broken copies at the end prove each rule still fires. SECRET_JOBS
// freezes each secret job, and the deploy workflow's header, as text (secret-jobs/*.yml): changing one means changing
// its copy in the same PR. A run line the deny rules don't name rests on that freeze and its review.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const WORKFLOWS = new URL('../../../.github/workflows/', import.meta.url)
const DEPLOY = 'sandbox-test-deploy.yml'
const CLEANUP = 'sandbox-test-deploy-cleanup.yml'
const FILES = Object.fromEntries(readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).map(f => [f, readFileSync(new URL(f, WORKFLOWS), 'utf8')]))

/** The workflow's text before `jobs:`, and each job's text. Throws on a job-level line that isn't a job key. */
function split(text) {
  const lines = text.split('\n')
  const at = lines.findIndex(l => /^jobs:\s*(#.*)?$/.test(l))
  if (at < 0) throw new Error('no jobs: line')
  const jobs = {}
  let id = null
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) { if (id) jobs[id].push(line); continue }
    if (/^\S/.test(line)) throw new Error(`a top-level key after jobs: ${JSON.stringify(line)}`)
    if (/^ {2}\S/.test(line)) {
      const m = /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+)):\s*(#.*)?$/.exec(line)
      if (!m) throw new Error(`a job-level line that isn't a job key: ${JSON.stringify(line)}`)
      id = m[1] ?? m[2] ?? m[3]
      if (Object.hasOwn(jobs, id)) throw new Error(`job ${id} twice`)
      jobs[id] = []
    }
    jobs[id].push(line)
  }
  return { header: lines.slice(0, at).join('\n').trimEnd(), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n').trimEnd()])) }
}
/** Each step's text, in order, without the comment lines that end it (they belong to the next step). */
const steps = job => job.split(/\n(?= {6}- )/).slice(1).map(s => s.replace(/(\n {6}#[^\n]*|\n\s*)+$/, ''))

/** Every secret a job reads: literal names (upper case), and whether it reads them by a form that names none. */
function secretsOf(text) {
  const names = new Set()
  let dynamic = false
  for (const m of text.matchAll(/\bsecrets\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_-]*)|\[\s*(['"])([^'"\]]*)\2\s*\]|(\[))|toJSON\s*\(\s*secrets\s*\)|\bsecrets\s*:\s*inherit\b/gi)) {
    if (m[1]) names.add(m[1].toUpperCase())
    else if (m[3] !== undefined) names.add(m[3].toUpperCase())
    else dynamic = true
  }
  return { names: [...names].sort(), dynamic }
}
/** The job's environment names as written (literal or not), from `environment: x`, `environment:\n name: x` or `{ name: x }`. */
function environmentsOf(job) {
  const out = []
  for (const m of job.matchAll(/\n {4}environment:[ \t]*([^\n]*)(?:\n {6}name:[ \t]*([^\n]*))?/g)) {
    let v = (m[1].replace(/#.*$/, '').trim() || m[2] || '').trim()
    const inline = /^\{.*\bname:\s*([^,}]+)/.exec(v)
    if (inline) v = inline[1].trim()
    out.push(v.replace(/^['"]|['"]$/g, ''))
  }
  return out
}

// The jobs that may use the `sandbox` environment, and the exact tripwire each runs first.
const TRIPWIRE = {
  [`${DEPLOY}#deploy`]: `      - name: Only from main, first attempt
        env:
          REF: \${{ github.ref }}
          ATTEMPT: \${{ github.run_attempt }}
        run: |
          [ "$REF" = refs/heads/main ] || { echo "::error::sandbox-test-deploy runs only from main (this run: $REF)"; exit 1; }
          [ "$ATTEMPT" = 1 ] || { echo "::error::dispatch again instead of re-running (attempt $ATTEMPT)"; exit 1; }`,
  [`${CLEANUP}#cleanup`]: `      - name: Only from main
        env:
          REF: \${{ github.ref }}
        run: |
          [ "$REF" = refs/heads/main ] || { echo "::error::sandbox-test-deploy-cleanup runs only from main (this run: $REF)"; exit 1; }`,
}
const PR_CODE_FIRST = `      - name: First attempt only
        env:
          ATTEMPT: \${{ github.run_attempt }}
        run: |
          [ "$ATTEMPT" = 1 ] || { echo "::error::dispatch again instead of re-running (attempt $ATTEMPT)"; exit 1; }`
const SANDBOX_SECRETS = ['CF_SANDBOX_TOKEN', 'CF_SANDBOX_ACCOUNT_ID', 'SBX_ZONE']
// Inside a token job: nothing that runs the PR's code or bends what main's code does.
const DENY = [
  [/\bnpm\s+(run|exec|install|i|x|test|start)\b|\bnpx\b|\byarn\b|\bpnpm\b|\bbun\b|npm\s+--prefix/, 'a package script'],
  [/\bgit\s+(checkout|switch|fetch|pull|reset|worktree|clone|apply|am)\b/, 'a git checkout of other code'],
  [/\bdocker\s+(run|exec|build|create|start|compose)\b/, 'running or building an image'],
  [/\b(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|BASH_ENV|ENV|PYTHONPATH)\s*[:=]/, 'an environment variable that loads code'],
  [/\bGITHUB_(ENV|PATH)\b/, 'a write to GITHUB_ENV or GITHUB_PATH'],
  [/:\s*write\b/, 'a write permission'],
  [/\bcontinue-on-error\b/, 'continue-on-error'],
  [/(\b(node|bash|sh|source|chmod|exec)|(^|[\s;&|])\.)\s+(-[^\s]+\s+)*["']?(\$\{?RUNNER_TEMP\}?|\$\{\{\s*runner\.temp\s*\}\})\/(artifact|image|issuer)\b/m, 'a file from the artifact run'],
]

/** Every rule this test holds, over a set of workflow files ({ name: text }). Returns the failures. */
function checkRules(files) {
  const f = []
  const parsed = {}
  for (const [name, text] of Object.entries(files)) {
    try { parsed[name] = split(text) } catch (e) { f.push(`${name}: ${e.message}`) }
  }
  const allowedEnv = Object.keys(TRIPWIRE)
  for (const [name, { jobs }] of Object.entries(parsed)) {
    const text = files[name]
    if (/uses:\s*actions\/cache[@/]/.test(text)) f.push(`${name}: restores an Actions cache`)
    for (const m of text.matchAll(/uses:\s*([^\s#]+)/g)) {
      if (!m[1].startsWith('./') && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(m[1])) f.push(`${name}: ${m[1]} is not pinned to a commit`)
    }
    for (const [id, job] of Object.entries(jobs)) {
      const key = `${name}#${id}`
      const envs = environmentsOf(job)
      for (const e of envs) {
        if (e.includes('${{')) f.push(`${key}: its environment isn't a literal`)
        if (/sandbox/i.test(e) && !allowedEnv.includes(key)) f.push(`${key}: uses the sandbox environment`)
      }
      if (/environment[\s\S]{0,40}sandbox/i.test(job) && !allowedEnv.includes(key) && !envs.some(e => /sandbox/i.test(e))) f.push(`${key}: names the sandbox environment in a form this test can't read`)
      const { names, dynamic } = secretsOf(job)
      if (dynamic) f.push(`${key}: reads secrets by a form that names none`)
      const own = names.filter(n => SANDBOX_SECRETS.includes(n))
      const mayRead = allowedEnv.includes(key) ? SANDBOX_SECRETS : key === `${DEPLOY}#pr-code` ? ['SBX_ZONE'] : []
      for (const n of own) if (!mayRead.includes(n)) f.push(`${key}: reads ${n}`)
      if ([DEPLOY, CLEANUP].includes(name) && !allowedEnv.includes(key)) {
        for (const n of names) if (!mayRead.includes(n)) f.push(`${key}: reads ${n}`)
      }
      for (const step of steps(job).filter(s => s.includes('actions/setup-node@'))) {
        if (/\n\s+cache:/.test(step)) f.push(`${key}: setup-node with cache:`)
        if ((allowedEnv.includes(key) || names.length) && [DEPLOY, CLEANUP].includes(name) && !step.includes('package-manager-cache: false')) f.push(`${key}: setup-node without package-manager-cache: false`)
      }
    }
  }
  for (const key of allowedEnv) {
    const [name, id] = key.split('#')
    const job = parsed[name]?.jobs[id]
    if (!job) { f.push(`${key}: missing`); continue }
    if (!environmentsOf(job).includes('sandbox')) f.push(`${key}: not on the sandbox environment`)
    if (steps(job)[0] !== TRIPWIRE[key]) f.push(`${key}: the first step isn't the exact main tripwire`)
    if (/\n {4}if:/.test(job) && key !== `${CLEANUP}#cleanup`) f.push(`${key}: a job-level if`)
    for (const step of steps(job).filter(s => s.includes('actions/checkout@'))) {
      if (/\n\s+repository:/.test(step)) f.push(`${key}: checks out another repository`)
      const ref = /\n\s+ref:\s*(.*)/.exec(step)?.[1]
      if (ref !== undefined && ref.trim() !== '${{ github.sha }}') f.push(`${key}: checks out ${ref.trim()}`)
      if (!step.includes('persist-credentials: false')) f.push(`${key}: a checkout keeps its credentials`)
    }
    for (const m of job.matchAll(/\bnpm\s+ci\b[^\n]*/g)) if (!m[0].includes('--ignore-scripts')) f.push(`${key}: npm ci without --ignore-scripts`)
    for (const [re, what] of DENY) if (re.test(job)) f.push(`${key}: ${what}`)
    if (job.includes('needs.pr-code.outputs')) f.push(`${key}: takes pr-code's outputs`)
  }
  const deploy = parsed[DEPLOY]?.jobs.deploy ?? ''
  const order = ['scripts/sandbox/deploy-config.mjs', 'check-product-config.mjs --sandbox --per-pr', 'scripts/sandbox/deploy.mjs'].map(s => deploy.indexOf(s))
  if (!order.every(i => i > 0) || order.some((v, i) => i > 0 && v < order[i - 1])) f.push('deploy: not deploy-config.mjs, then the lock, then deploy.mjs')
  if (!deploy.includes('--artifact "$RUNNER_TEMP/artifact"')) f.push('deploy: deploy-config.mjs doesn\'t read the artifact folder')
  if (JSON.stringify(Object.keys(parsed[DEPLOY]?.jobs ?? {})) !== JSON.stringify(['check', 'pr-code', 'deploy'])) f.push(`the deploy workflow's jobs are ${JSON.stringify(Object.keys(parsed[DEPLOY]?.jobs ?? {}))}`)
  if (JSON.stringify(Object.keys(parsed[CLEANUP]?.jobs ?? {})) !== JSON.stringify(['cleanup'])) f.push(`the cleanup workflow's jobs are ${JSON.stringify(Object.keys(parsed[CLEANUP]?.jobs ?? {}))}`)
  const prCode = parsed[DEPLOY]?.jobs['pr-code'] ?? ''
  const perms = /\n {4}permissions:\n((?: {6}.*\n)+)/.exec(`${prCode}\n`)?.[1].split('\n').map(l => l.trim()).filter(Boolean).sort()
  if (JSON.stringify(perms) !== JSON.stringify(['actions: read', 'contents: read'])) f.push(`pr-code: permissions ${JSON.stringify(perms)}`)
  if (environmentsOf(prCode).length) f.push('pr-code: has an environment')
  if (steps(prCode)[0] !== PR_CODE_FIRST) f.push('pr-code: the first step isn\'t the first-attempt check')
  const check = parsed[DEPLOY]?.jobs.check ?? ''
  for (const line of ['[ "$ATTEMPT" = 1 ] ||', '[ "$head_repo" = "$REPO" ] ||', '[ "$head_sha" = "$SHA" ] ||', '[ "$state" = open ] ||']) {
    if (!check.includes(line)) f.push(`check: lost ${line}`)
  }
  const on = h => (/\non:\n((?: {2}.*\n|\n)+?)(?=\S)/.exec(`${h.split('\n').filter(l => !/^#/.test(l)).join('\n')}\n`)?.[1] ?? '').match(/^ {2}[a-z_]+:/gm) ?? []
  if (JSON.stringify(on(parsed[DEPLOY]?.header ?? '')) !== JSON.stringify(['  workflow_dispatch:'])) f.push('the deploy workflow starts on something but dispatch')
  if (JSON.stringify(on(parsed[CLEANUP]?.header ?? '')) !== JSON.stringify(['  pull_request_target:', '  schedule:', '  workflow_dispatch:'])) f.push('the cleanup starts on something else')
  if (!/pull_request_target:\n {4}types: \[closed\]\n(?: {4}#.*\n)* {4}branches: \[main\]\n/.test(files[CLEANUP] ?? '')) f.push('the cleanup\'s PR trigger isn\'t closed PRs into main')
  return f
}

const frozen = name => readFileSync(new URL(`secret-jobs/${name}`, import.meta.url), 'utf8').trimEnd()
const SECRET_JOBS = {
  [`${DEPLOY}#deploy`]: frozen('sandbox-test-deploy.deploy.yml'),
  [`${CLEANUP}#cleanup`]: frozen('sandbox-test-deploy-cleanup.cleanup.yml'),
}

describe('secret jobs are frozen', () => {
  test('each secret job is exactly its frozen copy', () => {
    for (const [key, copy] of Object.entries(SECRET_JOBS)) {
      const [file, id] = key.split('#')
      expect(split(FILES[file]).jobs[id], key).toBe(copy)
    }
    expect(Object.keys(SECRET_JOBS).sort()).toEqual(Object.keys(TRIPWIRE).sort())
  })
  test('each workflow\'s header (its triggers, top permissions, concurrency, defaults, env) is exactly its frozen copy', () => {
    expect(split(FILES[DEPLOY]).header).toBe(frozen('sandbox-test-deploy.header.yml'))
    expect(split(FILES[CLEANUP]).header).toBe(frozen('sandbox-test-deploy-cleanup.header.yml'))
  })
  test('split() reads a job key with an inline comment, quoted keys, and a jobs: line with a comment', () => {
    const { jobs } = split('on: push\njobs: # all\n  a: # first\n    runs-on: x\n  "b":\n    runs-on: y\n')
    expect(Object.keys(jobs)).toEqual(['a', 'b'])
  })
})

describe('the rules hold on every workflow file', () => {
  test('no failures', () => {
    expect(checkRules(FILES)).toEqual([])
  })
  test('no package.json turns setup-node\'s cache on by itself (a packageManager field)', () => {
    for (const pkg of ['../../package.json', '../../hub/package.json', '../../runner/package.json']) {
      const json = JSON.parse(readFileSync(new URL(pkg, import.meta.url), 'utf8'))
      expect(json.packageManager, pkg).toBeUndefined()
      expect(json.devEngines?.packageManager, pkg).toBeUndefined()
    }
  })
})

// Broken copies: each one must make checkRules fail with the named reason, so a rule that stops firing fails here.
describe('each rule fires on a broken copy', () => {
  const swap = (file, from, to) => {
    if (FILES[file].split(from).length !== 2) throw new Error(`${file} hasn't exactly one ${JSON.stringify(from.slice(0, 60))}`)
    return { ...FILES, [file]: FILES[file].replace(from, () => to) }
  }
  const job = (file, text) => ({ ...FILES, [file]: `${FILES[file].trimEnd()}\n\n${text}\n` })
  const extra = body => `  extra:\n    runs-on: ubuntu-latest\n${body}\n    steps:\n      - run: echo`
  const cases = [
    ['a new job on the sandbox environment', job(DEPLOY, extra('    environment: sandbox')), 'deploy.yml#extra: uses the sandbox environment'],
    ['the environment as an object', job(DEPLOY, extra('    environment:\n      name: sandbox')), 'uses the sandbox environment'],
    ['a quoted job key', job(DEPLOY, extra('    environment: sandbox').replace('  extra:', '  "extra":')), 'deploy.yml#extra: uses the sandbox environment'],
    ['a non-literal environment', job(DEPLOY, extra('    environment: ${{ inputs.env }}')), 'its environment isn\'t a literal'],
    ['the token in lower case', job(DEPLOY, extra('    env:\n      T: ${{ secrets.cf_sandbox_token }}')), 'reads CF_SANDBOX_TOKEN'],
    ['the token by index', job(DEPLOY, extra("    env:\n      T: ${{ secrets['CF_SANDBOX_TOKEN'] }}")), 'reads CF_SANDBOX_TOKEN'],
    ['every secret at once', swap(DEPLOY, '      CONTAINERS: ${{ inputs.containers }}\n          E2E_TEST_BUILD_REMOTE', '      CONTAINERS: ${{ toJSON(secrets) }}\n          E2E_TEST_BUILD_REMOTE'), 'reads secrets by a form that names none'],
    ['another secret in pr-code', swap(DEPLOY, '          SBX_ZONE: ${{ secrets.SBX_ZONE }}\n        run: |\n          [ -n "$SBX_ZONE" ]', '          SBX_ZONE: ${{ secrets.OTHER }}\n        run: |\n          [ -n "$SBX_ZONE" ]'), 'pr-code: reads OTHER'],
    ['a new workflow file on the sandbox environment', { ...FILES, 'new.yml': `on:\n  pull_request_target:\njobs:\n${extra('    environment: sandbox')}\n` }, 'new.yml#extra: uses the sandbox environment'],
    ['a job-level line that isn\'t a job key', job(DEPLOY, '  - not a job'), 'a job-level line that isn\'t a job key'],
    ['continue-on-error on the tripwire', swap(DEPLOY, "attempt 1's artifacts.\n      - name: Only from main, first attempt\n", "attempt 1's artifacts.\n      - name: Only from main, first attempt\n        continue-on-error: true\n"), 'the first step isn\'t the exact main tripwire'],
    ['an if on the tripwire', swap(DEPLOY, "attempt 1's artifacts.\n      - name: Only from main, first attempt\n", "attempt 1's artifacts.\n      - name: Only from main, first attempt\n        if: false\n"), 'the first step isn\'t the exact main tripwire'],
    ['|| true after the tripwire', swap(DEPLOY, 'runs only from main (this run: $REF)"; exit 1; }\n          [ "$ATTEMPT" = 1 ] || { echo "::error::dispatch again instead of re-running (attempt $ATTEMPT)"; exit 1; }\n      # Secrets', 'runs only from main (this run: $REF)"; exit 1; } || true\n          [ "$ATTEMPT" = 1 ] || { echo "::error::dispatch again instead of re-running (attempt $ATTEMPT)"; exit 1; }\n      # Secrets'), 'the first step isn\'t the exact main tripwire'],
    ['exit 0 in the cleanup\'s tripwire', swap(CLEANUP, 'cleanup runs only from main (this run: $REF)"; exit 1; }', 'cleanup runs only from main (this run: $REF)"; exit 0; }'), 'cleanup: the first step isn\'t the exact main tripwire'],
    ['git checkout of the PR', swap(DEPLOY, '        run: npm ci --ignore-scripts', '        run: git checkout "$SHA" && npm ci --ignore-scripts'), 'deploy: a git checkout of other code'],
    ['docker run of the PR\'s image', swap(DEPLOY, '          zstd -dc "$RUNNER_TEMP/image/image.tar.zst" | docker load', '          zstd -dc "$RUNNER_TEMP/image/image.tar.zst" | docker load\n          docker run "inhouse-sbx-pr$PR:$SHA"'), 'running or building an image'],
    ['NODE_OPTIONS on the job', swap(DEPLOY, '      CONTAINERS: ${{ inputs.containers }}\n    steps:', '      CONTAINERS: ${{ inputs.containers }}\n      NODE_OPTIONS: --require ./x.js\n    steps:'), 'an environment variable that loads code'],
    ['contents: write', swap(DEPLOY, '    permissions:\n      contents: read\n      actions: read\n    env:', '    permissions:\n      contents: write\n      actions: read\n    env:'), 'a write permission'],
    ['npm --prefix run', swap(DEPLOY, '        run: npm ci --ignore-scripts', '        run: npm ci --ignore-scripts && npm --prefix x run y'), 'a package script'],
    ['a script from the artifact', swap(DEPLOY, '        run: npm ci --ignore-scripts', '        run: npm ci --ignore-scripts && node "$RUNNER_TEMP/artifact/x.mjs"'), 'a file from the artifact run'],
    ['npm ci with scripts', swap(DEPLOY, '        run: npm ci --ignore-scripts', '        run: npm ci'), 'npm ci without --ignore-scripts'],
    ['a PR-head checkout', swap(DEPLOY, '          path: main\n', '          path: main\n          ref: ${{ needs.check.outputs.sha }}\n'), 'checks out ${{ needs.check.outputs.sha }}'],
    ['pr-code without its first-attempt check', swap(DEPLOY, PR_CODE_FIRST + '\n', ''), 'pr-code: the first step isn\'t the first-attempt check'],
    ['pr-code on the sandbox environment', swap(DEPLOY, '      actions: read\n      contents: read\n', '      actions: read\n      contents: read\n    environment: sandbox\n'), 'pr-code: has an environment'],
    ['check without the fork refusal', swap(DEPLOY, '          [ "$head_repo" = "$REPO" ] || { echo "::error::PR $PR comes from $head_repo, not $REPO (forks never deploy)"; exit 1; }\n', ''), 'check: lost [ "$head_repo" = "$REPO" ] ||'],
    ['a push trigger', swap(DEPLOY, 'on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'), 'starts on something but dispatch'],
    ['a push trigger behind a column-0 comment', swap(DEPLOY, 'on:\n  workflow_dispatch:', 'on:\n  workflow_dispatch:\n# note\n  push:'), 'starts on something but dispatch'],
    ['secrets: inherit', job(DEPLOY, '  extra:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit'), 'reads secrets by a form that names none'],
    ['a new job in the deploy workflow', job(DEPLOY, extra('')), 'the deploy workflow\'s jobs are'],
    ['an Actions cache', job(DEPLOY, '  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/cache@0000000000000000000000000000000000000000'), 'restores an Actions cache'],
    ['an action by tag', job(DEPLOY, '  extra:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/upload-artifact@v7'), 'is not pinned to a commit'],
  ]
  for (const [name, files, reason] of cases) {
    test(name, () => {
      const failures = checkRules(files)
      expect(failures.some(x => x.includes(reason)), `${reason} in ${JSON.stringify(failures)}`).toBe(true)
    })
  }
})
