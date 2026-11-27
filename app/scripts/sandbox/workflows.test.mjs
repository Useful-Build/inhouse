// The trust rules of the sandbox test deploy's workflows, held by test (as the ops repo's scripts/workflows.test.mjs
// holds its own). What it guards against: mistakes and unreviewed drift. Someone with write access to main is trusted,
// as in the ops repo: they could change this test too. Ways the rules could break, written down first:
//  1. a job that can reach the sandbox token (the `sandbox` environment) runs the PR's code: checks the PR out, runs a
//     package script (`npm run`, `npx`, a plain `npm ci`), runs the PR's image or a file from its artifact, uses an
//     action beyond checkout, setup-node and download-artifact, or loses or neutralises the main tripwire;
//  2. it takes the PR's build some other way than deploy-config.mjs's exact file list, or deploys before the lock;
//  3. any other job names the `sandbox` environment (or an environment that is an expression), in any workflow file;
//  4. a job other than the two token jobs mentions `secrets` at all in the sandbox workflows (pr-code may hold exactly
//     `${{ secrets.SBX_ZONE }}`), or any workflow reads a sandbox secret or reads secrets by a form that names none;
//  5. the deploy workflow gains a trigger a branch or a fork controls, or a job;
//  6. a job that holds a secret restores an Actions cache the PR's code could have written (pr-code runs on main);
//  7. an action is pinned by tag, not by commit.
// Every rule reads the workflow as YAML (the `yaml` package), so quoting, key order and block style don't matter. The
// frozen copies (secret-jobs/*.yml) and the exact tripwire steps are compared as text: changing a token job means
// changing its copy in the same PR. The broken copies at the end prove each rule still fires.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

const WORKFLOWS = new URL('../../../.github/workflows/', import.meta.url)
const DEPLOY = 'sandbox-test-deploy.yml'
const CLEANUP = 'sandbox-test-deploy-cleanup.yml'
const FILES = Object.fromEntries(readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).map(f => [f, readFileSync(new URL(f, WORKFLOWS), 'utf8')]))

/** For the frozen copies only: the text before `jobs:`, and each job's text, by indentation. */
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
      jobs[id] = []
    }
    jobs[id].push(line)
  }
  return { header: lines.slice(0, at).join('\n').trimEnd(), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n').trimEnd()])) }
}
/** For the tripwire text checks: each step's text, without the comment and blank lines that end it. */
const stepTexts = job => job.split(/\n(?= {6}- )/).slice(1).map(s => s.replace(/(?:\n(?: {6}#[^\n]*|[ \t]*))+$/, ''))

/** The strings that are expressions: every ${{ }} inside a value, and a whole `if:` value (it needs no braces). */
const expressions = (path, s) => [...s.matchAll(/\$\{\{([^]*?)\}\}/g)].map(m => m[1]).concat(/\.if$/.test(path) ? [s] : [])

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
const TOKEN_JOBS = Object.keys(TRIPWIRE)
const PR_CODE = `${DEPLOY}#pr-code`
const SBX_ZONE_REF = '${{ secrets.SBX_ZONE }}'
const SANDBOX_SECRET = /\b(CF_SANDBOX_TOKEN|CF_SANDBOX_ACCOUNT_ID|SBX_ZONE)\b/i
const TOKEN_JOB_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/download-artifact']
// In a token job's run text: nothing that runs the PR's code or bends what main's code does.
const DENY_RUN = [
  [/\bnpm\s+(run|exec|install|i|x|test|start|rebuild|link)\b|\bnpx\b|\byarn\b|\bpnpm\b|\bbun\b|npm\s+--prefix/, 'a package script'],
  [/\bgit\s+(checkout|switch|fetch|pull|reset|worktree|clone|apply|am)\b/, 'a git checkout of other code'],
  [/\bdocker\s+(run|exec|build|create|start|compose)\b/, 'running or building an image'],
  [/\bGITHUB_(ENV|PATH)\b/, 'a write to GITHUB_ENV or GITHUB_PATH'],
  [/(\b(node|bash|sh|source|chmod|exec)|(^|[\s;&|])\.)\s+(-[^\s]+\s+)*["']?(\$\{?RUNNER_TEMP\}?|\$\{\{\s*runner\.temp\s*\}\})\/(artifact|image|issuer)\b/m, 'a file from the artifact run'],
]
const DENY_ENV = /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP)$/i

/** Every string in a parsed value, keys included, with its path. */
function strings(value, path = '') {
  if (typeof value === 'string') return [[path, value]]
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [[`${path}.${k}(key)`, k], ...strings(v, `${path}.${k}`)])
  return []
}
/** A job's environment name: the string, or `{ name }`; null when it has none. */
const environmentOf = job => (job.environment === undefined ? null : typeof job.environment === 'string' ? job.environment : job.environment?.name ?? '')
const actionOf = step => (typeof step?.uses === 'string' ? step.uses.split('@')[0] : null)
const runText = job => (job.steps ?? []).map(s => (typeof s?.run === 'string' ? s.run : '')).join('\n')

/** Every rule this test holds, over a set of workflow files ({ name: text }). Returns the failures. */
function checkRules(files) {
  const f = []
  const docs = {}
  for (const [name, text] of Object.entries(files)) {
    try {
      const doc = parse(text, { merge: false, uniqueKeys: true })
      if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') throw new Error('no jobs')
      docs[name] = doc
    } catch (e) { f.push(`${name}: can't be read as a workflow (${e.message.split('\n')[0]})`) }
  }
  for (const [name, doc] of Object.entries(docs)) {
    const sandboxFile = [DEPLOY, CLEANUP].includes(name)
    for (const [id, job] of Object.entries(doc.jobs)) {
      const key = `${name}#${id}`
      const token = TOKEN_JOBS.includes(key)
      // Environments (failure 3).
      const env = environmentOf(job ?? {})
      if (env !== null) {
        if (typeof env !== 'string' || env === '' || env.includes('${{')) f.push(`${key}: its environment isn't a literal name`)
        else if (/sandbox/i.test(env) && !token) f.push(`${key}: uses the sandbox environment`)
        else if (token && env !== 'sandbox') f.push(`${key}: its environment isn't exactly sandbox`)
        else if (sandboxFile && !token) f.push(`${key}: has an environment`)
      } else if (token) f.push(`${key}: not on the sandbox environment`)
      // Secrets (failure 4).
      for (const [path, s] of strings(job)) {
        if (!/secrets/i.test(s)) continue
        if (sandboxFile && !token && !(key === PR_CODE && s === SBX_ZONE_REF)) f.push(`${key}: mentions secrets (${path})`)
        if (sandboxFile) continue
        // Elsewhere (where prose may say "secrets"): a `secrets` key fails, and in every ${{ }} expression only
        // `secrets.<NAME>` reads pass, never a sandbox secret's: `(secrets)`, `toJSON(secrets)`, `secrets[x]` fail.
        if (/\(key\)$/.test(path) && /^secrets$/i.test(s.trim())) f.push(`${key}: reads secrets by a form that names none (${path})`)
        for (const expr of expressions(path, s)) {
          if (SANDBOX_SECRET.test(expr) && /secrets/i.test(expr)) f.push(`${key}: reads a sandbox secret (${path})`)
          if (/secrets/i.test(expr.replace(/\bsecrets\.[A-Za-z_][A-Za-z0-9_]*/g, ''))) f.push(`${key}: reads secrets by a form that names none (${path})`)
        }
      }
      // Actions, caches, pins (failures 6, 7).
      for (const step of job?.steps ?? []) {
        const uses = typeof step?.uses === 'string' ? step.uses : null
        if (!uses) continue
        if (actionOf(step) === 'actions/cache' || uses.startsWith('actions/cache/')) f.push(`${key}: restores an Actions cache`)
        if (!uses.startsWith('./') && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/.test(uses)) f.push(`${key}: ${uses} is not pinned to a commit`)
        if (actionOf(step) === 'actions/setup-node') {
          if (step.with?.cache !== undefined) f.push(`${key}: setup-node with cache`)
          if (sandboxFile && (token || strings(job).some(([, s]) => /secrets/i.test(s))) && step.with?.['package-manager-cache'] !== false) f.push(`${key}: setup-node without package-manager-cache: false`)
        }
      }
      if (typeof job?.uses === 'string' && !job.uses.startsWith('./') && !/@[0-9a-f]{40}$/.test(job.uses)) f.push(`${key}: ${job.uses} is not pinned to a commit`)
    }
  }
  // The token jobs (failures 1, 2).
  for (const key of TOKEN_JOBS) {
    const [name, id] = key.split('#')
    const job = docs[name]?.jobs?.[id]
    if (!job) { f.push(`${key}: missing`); continue }
    let first = null
    try { first = stepTexts(split(files[name]).jobs[id] ?? '')[0] } catch (e) { f.push(`${name}: ${e.message}`) }
    if (first !== TRIPWIRE[key]) f.push(`${key}: the first step isn't the exact main tripwire`)
    if (job.if !== undefined && key !== `${CLEANUP}#cleanup`) f.push(`${key}: a job-level if`)
    if (job['continue-on-error'] !== undefined || (job.steps ?? []).some(s => s?.['continue-on-error'] !== undefined)) f.push(`${key}: continue-on-error`)
    const perms = job.permissions
    if (perms === 'write-all' || strings(perms ?? {}).some(([, v]) => v === 'write')) f.push(`${key}: a write permission`)
    for (const env of [job.env, ...(job.steps ?? []).map(s => s?.env)]) {
      for (const k of Object.keys(env ?? {})) if (DENY_ENV.test(k)) f.push(`${key}: ${k}, an environment variable that loads code`)
    }
    for (const step of job.steps ?? []) {
      const action = actionOf(step)
      if (action && !TOKEN_JOB_ACTIONS.includes(action)) f.push(`${key}: uses ${action}`)
      if (action === 'actions/checkout') {
        if (step.with?.repository !== undefined) f.push(`${key}: checks out another repository`)
        if (step.with?.ref !== undefined && step.with.ref !== '${{ github.sha }}') f.push(`${key}: checks out ${step.with.ref}`)
        if (step.with?.['persist-credentials'] !== false) f.push(`${key}: a checkout keeps its credentials`)
      }
    }
    const run = runText(job)
    // Exactly `npm ci --ignore-scripts`: no `--ignore-scripts=false`, nothing else on the line.
    for (const m of run.matchAll(/\bnpm\s+ci\b[^\n]*/g)) if (m[0].trim() !== 'npm ci --ignore-scripts') f.push(`${key}: npm ci without --ignore-scripts`)
    for (const [re, what] of DENY_RUN) if (re.test(run)) f.push(`${key}: ${what}`)
    if (strings(job).some(([, s]) => s.includes('needs.pr-code.outputs'))) f.push(`${key}: takes pr-code's outputs`)
  }
  const deployRun = runText(docs[DEPLOY]?.jobs?.deploy ?? {})
  const order = ['scripts/sandbox/deploy-config.mjs', 'check-product-config.mjs --sandbox --per-pr', 'scripts/sandbox/deploy.mjs'].map(s => deployRun.indexOf(s))
  if (!order.every(i => i >= 0) || order.some((v, i) => i > 0 && v < order[i - 1])) f.push('deploy: not deploy-config.mjs, then the lock, then deploy.mjs')
  if (!deployRun.includes('--artifact "$RUNNER_TEMP/artifact"')) f.push('deploy: deploy-config.mjs doesn\'t read the artifact folder')
  // pr-code and check (failures 3, 4).
  const prCode = docs[DEPLOY]?.jobs?.['pr-code'] ?? {}
  if (JSON.stringify(prCode.permissions) !== JSON.stringify({ actions: 'read', contents: 'read' })) f.push(`pr-code: permissions ${JSON.stringify(prCode.permissions)}`)
  let prFirst = null
  try { prFirst = stepTexts(split(files[DEPLOY] ?? '').jobs['pr-code'] ?? '')[0] } catch { /* the split failure is reported above */ }
  if (prFirst !== PR_CODE_FIRST) f.push('pr-code: the first step isn\'t the first-attempt check')
  // Triggers and job lists (failure 5).
  const keys = v => (v && typeof v === 'object' ? Object.keys(v) : [v])
  if (JSON.stringify(keys(docs[DEPLOY]?.on)) !== JSON.stringify(['workflow_dispatch'])) f.push('the deploy workflow starts on something but dispatch')
  if (JSON.stringify(keys(docs[CLEANUP]?.on)) !== JSON.stringify(['pull_request_target', 'schedule', 'workflow_dispatch'])) f.push('the cleanup starts on something else')
  if (JSON.stringify(docs[CLEANUP]?.on?.pull_request_target) !== JSON.stringify({ types: ['closed'], branches: ['main'] })) f.push('the cleanup\'s PR trigger isn\'t closed PRs into main')
  if (JSON.stringify(Object.keys(docs[DEPLOY]?.jobs ?? {})) !== JSON.stringify(['check', 'pr-code', 'deploy'])) f.push(`the deploy workflow's jobs are ${JSON.stringify(Object.keys(docs[DEPLOY]?.jobs ?? {}))}`)
  if (JSON.stringify(Object.keys(docs[CLEANUP]?.jobs ?? {})) !== JSON.stringify(['cleanup'])) f.push(`the cleanup workflow's jobs are ${JSON.stringify(Object.keys(docs[CLEANUP]?.jobs ?? {}))}`)
  return f
}

const frozen = name => readFileSync(new URL(`secret-jobs/${name}`, import.meta.url), 'utf8').trimEnd()
const SECRET_JOBS = {
  [`${DEPLOY}#deploy`]: frozen('sandbox-test-deploy.deploy.yml'),
  [`${CLEANUP}#cleanup`]: frozen('sandbox-test-deploy-cleanup.cleanup.yml'),
}
// `check` holds no secret, but its refusals (main only, first attempt, an open same-repo PR at exactly the head SHA,
// the `only` allowlist) are what "forks never deploy" rests on, so it is frozen too.
const FROZEN_JOBS = { ...SECRET_JOBS, [`${DEPLOY}#check`]: frozen('sandbox-test-deploy.check.yml') }

describe('secret jobs are frozen', () => {
  test('each secret job, and check, is exactly its frozen copy', () => {
    for (const [key, copy] of Object.entries(FROZEN_JOBS)) {
      const [file, id] = key.split('#')
      expect(split(FILES[file]).jobs[id], key).toBe(copy)
    }
    expect(Object.keys(SECRET_JOBS).sort()).toEqual([...TOKEN_JOBS].sort())
  })
  test('each workflow\'s header (its triggers, top permissions, concurrency, defaults, env) is exactly its frozen copy', () => {
    expect(split(FILES[DEPLOY]).header).toBe(frozen('sandbox-test-deploy.header.yml'))
    expect(split(FILES[CLEANUP]).header).toBe(frozen('sandbox-test-deploy-cleanup.header.yml'))
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
  // The deploy job's install, by its working directory: pr-code's has the same run line, in pr/app.
  const MAIN_APP = '      - working-directory: main/app\n'
  const MAIN_CI = `${MAIN_APP}        run: npm ci --ignore-scripts`
  const extra = body => `  extra:\n    runs-on: ubuntu-latest\n${body}\n    steps:\n      - run: echo`
  const newFile = body => ({ ...FILES, 'new.yml': `on:\n  pull_request_target:\njobs:\n${extra(body)}\n` })
  const prEnv = to => swap(DEPLOY, '          SBX_ZONE: ${{ secrets.SBX_ZONE }}\n        run: |\n          [ -n "$SBX_ZONE" ]', `          SBX_ZONE: ${to}\n        run: |\n          [ -n "$SBX_ZONE" ]`)
  const DEPLOY_TRIP = "attempt 1's artifacts.\n      - name: Only from main, first attempt\n"
  const cases = [
    ['a new job on the sandbox environment', job(DEPLOY, extra('    environment: sandbox')), 'deploy.yml#extra: uses the sandbox environment'],
    ['the environment as an object', newFile('    environment:\n      name: sandbox'), 'new.yml#extra: uses the sandbox environment'],
    ['the environment with url before name', newFile('    environment:\n      url: https://example.com\n      name: sandbox'), 'new.yml#extra: uses the sandbox environment'],
    ['the environment as a format expression', newFile("    environment:\n      url: https://x\n      name: ${{ format('{0}{1}', 'sand', 'box') }}"), 'new.yml#extra: its environment isn\'t a literal name'],
    ['a quoted environment key', newFile('    "environment": sandbox'), 'new.yml#extra: uses the sandbox environment'],
    ['a quoted job key', job(DEPLOY, extra('    environment: sandbox').replace('  extra:', '  "extra":')), 'deploy.yml#extra: uses the sandbox environment'],
    ['a non-literal environment', newFile('    environment: ${{ inputs.env }}'), 'its environment isn\'t a literal name'],
    ['the token in lower case, in a new file', newFile('    env:\n      T: ${{ secrets.cf_sandbox_token }}'), 'new.yml#extra: reads a sandbox secret'],
    ['the token by index, in a new file', newFile("    env:\n      T: ${{ secrets['CF_SANDBOX_TOKEN'] }}"), 'new.yml#extra: reads a sandbox secret'],
    ['(secrets) in a new file', newFile('    env:\n      T: ${{ (secrets).OTHER }}'), 'new.yml#extra: reads secrets by a form that names none'],
    ['toJSON((secrets)) in a new file', newFile('    env:\n      T: ${{ toJSON((secrets)) }}'), 'new.yml#extra: reads secrets by a form that names none'],
    ['secrets: "inherit" in a new file', { ...FILES, 'new.yml': 'on:\n  push:\njobs:\n  extra:\n    uses: ./.github/workflows/x.yml\n    secrets: "inherit"\n' }, 'new.yml#extra: reads secrets by a form that names none'],
    ['toJSON(secrets) in pr-code', prEnv('${{ toJSON(secrets) }}'), 'pr-code: mentions secrets'],
    ['join(secrets.*) in pr-code', prEnv("${{ join(secrets.*, ' ') }}"), 'pr-code: mentions secrets'],
    ['an escaped secrets in pr-code', prEnv('"${{ \\x73ecrets.OTHER }}"'), 'pr-code: mentions secrets'],
    ['secrets.* in a new file', newFile('    env:\n      T: ${{ toJSON(secrets.*) }}'), 'new.yml#extra: reads secrets by a form that names none'],
    ['an escaped secrets in a new file', newFile('    env:\n      T: "${{ \\x73ecrets[format(\'{0}\', \'X\')] }}"'), 'new.yml#extra: reads secrets by a form that names none'],
    ['a sandbox secret in an if without braces', { ...FILES, 'new.yml': "on:\n  push:\njobs:\n  extra:\n    runs-on: ubuntu-latest\n    if: secrets.SBX_ZONE != ''\n    steps:\n      - run: echo\n" }, 'new.yml#extra: reads a sandbox secret'],
    ['an escaped environment name', newFile('    environment: "sand\\x62ox"'), 'new.yml#extra: uses the sandbox environment'],
    ['an environment through an alias', newFile('    env:\n      X: &e sandbox\n    environment: *e'), 'new.yml#extra: uses the sandbox environment'],
    ['deployment: false first and a comment between', newFile('    environment:\n      deployment: false\n      # a note\n      name: sandbox # here'), 'new.yml#extra: uses the sandbox environment'],
    ['an escaped environment key', newFile('    "\\x65nvironment": sandbox'), 'new.yml#extra: uses the sandbox environment'],
    ['npm ci --ignore-scripts=false', swap(DEPLOY, MAIN_CI, MAIN_APP + '        run: npm ci --ignore-scripts=false'), 'npm ci without --ignore-scripts'],
    ['npm rebuild', swap(DEPLOY, MAIN_CI, MAIN_APP + '        run: |\n          npm ci --ignore-scripts\n          npm rebuild'), 'a package script'],
    ['an environment on check', swap(DEPLOY, '    permissions:\n      pull-requests: read\n', '    permissions:\n      pull-requests: read\n    environment:\n      url: https://x\n      name: sandbox\n'), 'deploy.yml#check: uses the sandbox environment'],
    ['(secrets).X in pr-code', prEnv('${{ (secrets).CF_SANDBOX_TOKEN }}'), 'pr-code: mentions secrets'],
    ['another secret in pr-code', prEnv('${{ secrets.OTHER }}'), 'pr-code: mentions secrets'],
    ['secrets: inherit in the deploy workflow', job(DEPLOY, "  extra:\n    uses: ./.github/workflows/x.yml\n    secrets: 'inherit'"), 'deploy.yml#extra: mentions secrets'],
    ['a new workflow file on the sandbox environment', newFile('    environment: sandbox'), 'new.yml#extra: uses the sandbox environment'],
    ['a line YAML can\'t read', job(DEPLOY, '  - not a job'), 'can\'t be read as a workflow'],
    ['continue-on-error on the tripwire', swap(DEPLOY, DEPLOY_TRIP, `${DEPLOY_TRIP}        continue-on-error: true\n`), 'the first step isn\'t the exact main tripwire'],
    ['an if on the tripwire', swap(DEPLOY, DEPLOY_TRIP, `${DEPLOY_TRIP}        if: false\n`), 'the first step isn\'t the exact main tripwire'],
    ['|| true after the tripwire', swap(DEPLOY, 'runs only from main (this run: $REF)"; exit 1; }\n          [ "$ATTEMPT" = 1 ] || { echo "::error::dispatch again instead of re-running (attempt $ATTEMPT)"; exit 1; }\n      # Secrets', 'runs only from main (this run: $REF)"; exit 1; } || true\n          [ "$ATTEMPT" = 1 ] || { echo "::error::dispatch again instead of re-running (attempt $ATTEMPT)"; exit 1; }\n      # Secrets'), 'the first step isn\'t the exact main tripwire'],
    ['exit 0 in the cleanup\'s tripwire', swap(CLEANUP, 'cleanup runs only from main (this run: $REF)"; exit 1; }', 'cleanup runs only from main (this run: $REF)"; exit 0; }'), 'cleanup: the first step isn\'t the exact main tripwire'],
    ['continue-on-error on a later step', swap(DEPLOY, '      - working-directory: main/app\n        run: npm ci --ignore-scripts', '      - working-directory: main/app\n        continue-on-error: true\n        run: npm ci --ignore-scripts'), 'deploy: continue-on-error'],
    ['git checkout of the PR', swap(DEPLOY, MAIN_CI, MAIN_APP + '        run: git checkout "$SHA" && npm ci --ignore-scripts'), 'deploy: a git checkout of other code'],
    ['docker run of the PR\'s image', swap(DEPLOY, '          zstd -dc "$RUNNER_TEMP/image/image.tar.zst" | docker load', '          zstd -dc "$RUNNER_TEMP/image/image.tar.zst" | docker load\n          docker run "inhouse-sbx-pr$PR:$SHA"'), 'running or building an image'],
    ['NODE_OPTIONS on the job', swap(DEPLOY, '      CONTAINERS: ${{ inputs.containers }}\n    steps:', '      CONTAINERS: ${{ inputs.containers }}\n      NODE_OPTIONS: --require ./x.js\n    steps:'), 'an environment variable that loads code'],
    ['contents: write', swap(DEPLOY, '    permissions:\n      contents: read\n      actions: read\n    env:', '    permissions:\n      contents: write\n      actions: read\n    env:'), 'a write permission'],
    ['npm --prefix run', swap(DEPLOY, MAIN_CI, MAIN_APP + '        run: npm ci --ignore-scripts && npm --prefix x run y'), 'a package script'],
    ['a script from the artifact', swap(DEPLOY, MAIN_CI, MAIN_APP + '        run: npm ci --ignore-scripts && node "$RUNNER_TEMP/artifact/x.mjs"'), 'a file from the artifact run'],
    ['npm ci with scripts', swap(DEPLOY, MAIN_CI, MAIN_APP + '        run: npm ci'), 'npm ci without --ignore-scripts'],
    ['a PR-head checkout', swap(DEPLOY, '          path: main\n', '          path: main\n          ref: ${{ needs.check.outputs.sha }}\n'), 'checks out ${{ needs.check.outputs.sha }}'],
    ['a second checkout as a block sequence item', swap(DEPLOY, '      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version-file: main/app/.nvmrc', '      -\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n        with:\n          ref: ${{ needs.check.outputs.sha }}\n          persist-credentials: false\n      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0\n        with:\n          node-version-file: main/app/.nvmrc'), 'checks out ${{ needs.check.outputs.sha }}'],
    ['another action in a token job', swap(DEPLOY, '      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        with:\n          name: build', '      - uses: some/action@0000000000000000000000000000000000000000\n      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2\n        with:\n          name: build'), 'deploy: uses some/action'],
    ['pr-code without its first-attempt check', swap(DEPLOY, PR_CODE_FIRST + '\n', ''), 'pr-code: the first step isn\'t the first-attempt check'],
    ['pr-code on the sandbox environment', swap(DEPLOY, '      actions: read\n      contents: read\n', '      actions: read\n      contents: read\n    environment: sandbox\n'), 'pr-code: uses the sandbox environment'],
    ['pr-code on another environment', swap(DEPLOY, '      actions: read\n      contents: read\n', '      actions: read\n      contents: read\n    environment: preview\n'), 'pr-code: has an environment'],
    ['a push trigger', swap(DEPLOY, 'on:\n  workflow_dispatch:', 'on:\n  push:\n  workflow_dispatch:'), 'starts on something but dispatch'],
    ['a quoted push trigger behind a comment', swap(DEPLOY, 'on:\n  workflow_dispatch:', 'on:\n  workflow_dispatch:\n# note\n  "push":'), 'starts on something but dispatch'],
    ['the cleanup on every PR\'s close', swap(CLEANUP, '    branches: [main]\n', ''), 'the cleanup\'s PR trigger isn\'t closed PRs into main'],
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
