// Every workflow job that holds a secret installs packages with exactly `npm ci --ignore-scripts`, so no dependency's
// install script runs where a secret or a write token is in reach. Version bumps leave Wasim's lane (Lane 4) only
// while this holds (the merge policy locked 2026-11-27, part 3 Q3). ci.yml's ignore-scripts job proves on every PR
// that those installs still build and run what the jobs need.
// A job holds a secret when it names an environment (every step gets that environment's secrets), reads `secrets` in
// any expression (its own or the workflow-level env, which every job gets), takes `secrets:` as a reusable workflow, or
// its token can write (its own permissions, else the workflow's; with neither, GitHub's default, which may write). A
// job in FEEDS_SECRET_JOBS holds no secret but makes what a secret job ships, so it's held the same way. In such a job:
//  1. every `npm ci` is exactly `npm ci --ignore-scripts` (no `=false`, nothing else on it);
//  2. no other npm command that installs or runs install scripts (install and its aliases, the `ci` aliases,
//     install-test, rebuild, update, link, dedupe, exec), and no npm option before the command (`npm --prefix x i`);
//  3. `npx` only as `npx --no-install`, so it runs what the lockfile installed and never downloads a package;
//  4. no other package manager (yarn, pnpm, bun, pip, corepack);
//  5. no npm_config_ignore_scripts in an env block, the workflow's included (the flag wins anyway; the variable is
//     only ever a mistake).
// Out of reach of this test: a `docker build` whose Dockerfile installs (it runs in the build container, which gets no
// secret) and `playwright install` (Playwright's own browser download, not a package's script).
// The broken copies at the end prove each rule fires.
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { parse } from 'yaml'

const WORKFLOWS = new URL('../../.github/workflows/', import.meta.url)
const FILES = Object.fromEntries(readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).map(f => [f, readFileSync(new URL(f, WORKFLOWS), 'utf8')]))

// Jobs with no secret whose output a secret job puts live: a package's install script there could change what ships.
const FEEDS_SECRET_JOBS = {
  // Its app-build artifact (dist/) is what deploy.yml's deploy job uploads to production.
  'deploy.yml#build': 'its dist/ goes live through deploy.yml deploy',
}

// The jobs that hold a secret (or feed one) and install packages today. A job that joins or leaves this list changes it here, so the
// detection below can't quietly stop finding them.
const INSTALLING_SECRET_JOBS = [
  'deploy.yml#build',
  'deploy.yml#deploy',
  'nightly.yml#connectors',
  'nightly.yml#slack-connectors',
  'preview-cleanup.yml#delete',
  'preview.yml#deploy',
  'sandbox-test-deploy.yml#deploy',
  'sandbox-test-deploy.yml#pr-code',
]

// npm's install commands and their aliases (npm 11 docs), plus the ones that run install scripts or fetch packages.
const NPM_INSTALLS = [
  'install', 'add', 'i', 'in', 'ins', 'inst', 'insta', 'instal', 'isnt', 'isnta', 'isntal', 'isntall',
  'clean-install', 'ic', 'install-clean', 'isntall-clean',
  'install-test', 'it', 'install-ci-test', 'cit', 'clean-install-test', 'sit',
  'rebuild', 'rb', 'update', 'up', 'upgrade', 'udpate', 'link', 'ln', 'dedupe', 'ddp', 'exec', 'x',
  'init', 'create', 'innit', 'audit',
]
const NPM_INSTALL = new RegExp(`\\bnpm\\s+(${NPM_INSTALLS.join('|')})(?![\\w:-])`)

/** Every string in a parsed value, keys included, with its path. */
function strings(value, path = '') {
  if (typeof value === 'string') return [[path, value]]
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [[`${path}.${k}(key)`, k], ...strings(v, `${path}.${k}`)])
  return []
}
/** The expressions in a string: each `${{ }}`, and an `if:` value whole (it may go without braces). */
const expressions = (path, s) => [...s.matchAll(/\$\{\{([^]*?)\}\}/g)].map(m => m[1]).concat(/\.if$/.test(path) ? [s] : [])
const canWrite = perms => perms === 'write-all' || (perms !== null && typeof perms === 'object' && Object.values(perms).includes('write'))

const readsSecrets = value => strings(value).some(([path, s]) => expressions(path, s).some(e => /\bsecrets\b/i.test(e)))

/** Why a job holds a secret (or is held as one), or null when it doesn't. */
function holdsSecret(doc, job, key) {
  if (FEEDS_SECRET_JOBS[key]) return FEEDS_SECRET_JOBS[key]
  if (job.environment !== undefined) return 'an environment'
  if (job.secrets !== undefined) return 'secrets passed in'
  if (readsSecrets(job)) return 'reads secrets'
  if (readsSecrets(doc.env ?? {})) return 'the workflow env reads secrets'
  const perms = job.permissions !== undefined ? job.permissions : doc.permissions
  if (perms === undefined) return 'the default token'
  if (canWrite(perms)) return 'a write token'
  return null
}

/** The rules over a set of workflow files ({ name: text }): the failures, and the secret jobs that install. */
function check(files) {
  const failures = []
  const installing = []
  for (const [name, text] of Object.entries(files)) {
    let doc
    try { doc = parse(text, { merge: false, uniqueKeys: true }) } catch (e) { failures.push(`${name}: can't be read (${e.message.split('\n')[0]})`); continue }
    for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
      const key = `${name}#${id}`
      const why = holdsSecret(doc, job ?? {}, key)
      if (!why) continue
      const run = (job.steps ?? []).map(s => (typeof s?.run === 'string' ? s.run : '')).join('\n')
      const ci = [...run.matchAll(/\bnpm\s+ci\b[^\n;&|)]*/g)].map(m => m[0].trim())
      if (ci.length > 0) installing.push(key)
      for (const c of ci) if (c !== 'npm ci --ignore-scripts') failures.push(`${key} (${why}): \`${c}\` isn't exactly npm ci --ignore-scripts`)
      const npm = run.match(NPM_INSTALL)
      if (npm) failures.push(`${key} (${why}): \`${npm[0]}\` installs or runs install scripts`)
      if (/\bnpm\s+-/.test(run)) failures.push(`${key} (${why}): an npm option before the command`)
      if (/\bnpx\b(?!\s+--no-install\b)/.test(run)) failures.push(`${key} (${why}): npx without --no-install`)
      const other = run.match(/\b(yarn|pnpm|bunx?|pipx?|pip3|corepack)\b/)
      if (other) failures.push(`${key} (${why}): ${other[1]}, another package manager`)
      for (const env of [doc.env, job.env, ...(job.steps ?? []).map(s => s?.env)]) {
        for (const k of Object.keys(env ?? {})) if (/^npm_config_ignore[-_]scripts$/i.test(k)) failures.push(`${key} (${why}): ${k} in an env block`)
      }
    }
  }
  return { failures, installing: installing.sort() }
}

describe('secret jobs install without install scripts', () => {
  test('no failures', () => {
    expect(check(FILES).failures).toEqual([])
  })
  test('the secret jobs that install are the known list', () => {
    expect(check(FILES).installing).toEqual(INSTALLING_SECRET_JOBS)
  })
})

describe('each rule fires on a broken copy', () => {
  const swap = (file, from, to) => {
    if (FILES[file].split(from).length !== 2) throw new Error(`${file} hasn't exactly one ${JSON.stringify(from.slice(0, 60))}`)
    return { ...FILES, [file]: FILES[file].replace(from, () => to) }
  }
  const DEPLOY_CI = '      - working-directory: app\n        run: npm ci --ignore-scripts\n\n      # A deploy goes ahead'
  const deployCi = run => swap('deploy.yml', DEPLOY_CI, DEPLOY_CI.replace('run: npm ci --ignore-scripts', run))
  const newFile = (top, job) => ({ ...FILES, 'new.yml': `on:\n  push:\n${top}jobs:\n  extra:\n    runs-on: ubuntu-latest\n${job}    steps:\n      - run: npm ci\n` })
  const cases = [
    ['plain npm ci in the production deploy', deployCi('run: npm ci'), 'deploy.yml#deploy (an environment): `npm ci` isn\'t exactly'],
    ['--ignore-scripts=false', deployCi('run: npm ci --ignore-scripts=false'), 'isn\'t exactly npm ci --ignore-scripts'],
    ['an extra flag after it', deployCi('run: npm ci --ignore-scripts --foreground-scripts'), 'isn\'t exactly npm ci --ignore-scripts'],
    ['npm rebuild after it', deployCi('run: npm ci --ignore-scripts && npm rebuild esbuild'), '`npm rebuild` installs'],
    ['npm install', deployCi('run: npm install'), '`npm install` installs'],
    ['npm ci by its alias', deployCi('run: npm clean-install'), '`npm clean-install` installs'],
    ['npm i in a block', deployCi('run: |\n          npm ci --ignore-scripts\n          npm i left-pad'), '`npm i` installs'],
    ['npm exec', deployCi('run: npm ci --ignore-scripts && npm exec wrangler'), '`npm exec` installs'],
    ['npm init', deployCi('run: npm ci --ignore-scripts && npm init some-starter'), '`npm init` installs'],
    ['npm create', deployCi('run: npm ci --ignore-scripts && npm create vite'), '`npm create` installs'],
    ['npm audit fix', deployCi('run: npm ci --ignore-scripts && npm audit fix'), '`npm audit` installs'],
    ['plain npm ci in the production build', swap('deploy.yml', '      - run: npm ci --ignore-scripts\n      - run: npm run build\n', '      - run: npm ci\n      - run: npm run build\n'), 'deploy.yml#build (its dist/ goes live through deploy.yml deploy): `npm ci` isn\'t exactly'],
    ['an option before the command', deployCi('run: npm --prefix . ci --ignore-scripts && npm --prefix . install'), 'an npm option before the command'],
    ['npx that may download', swap('preview-cleanup.yml', 'npx --no-install wrangler', 'npx wrangler'), 'preview-cleanup.yml#delete (an environment): npx without --no-install'],
    ['yarn', deployCi('run: yarn install --frozen-lockfile'), 'yarn, another package manager'],
    ['the env override', swap('nightly.yml', "        working-directory: app/hub\n        run: npm ci --ignore-scripts\n      # The filter", "        working-directory: app/hub\n        env:\n          npm_config_ignore_scripts: \"false\"\n        run: npm ci --ignore-scripts\n      # The filter"), 'nightly.yml#connectors (an environment): npm_config_ignore_scripts in an env block'],
    ['the hub in pr-code', swap('sandbox-test-deploy.yml', '(cd hub && npm ci --ignore-scripts && npm run bundle:test)', '(cd hub && npm ci && npm run bundle:test)'), 'sandbox-test-deploy.yml#pr-code (reads secrets): `npm ci` isn\'t exactly'],
    ['a job that reads a secret', newFile('permissions: {}\n', '    env:\n      T: ${{ secrets.ANY }}\n'), 'new.yml#extra (reads secrets)'],
    ['a secret in an if without braces', newFile('permissions: {}\n', "    if: secrets.ANY != ''\n"), 'new.yml#extra (reads secrets)'],
    ['a secret in the workflow env', newFile('permissions: {}\nenv:\n  T: ${{ secrets.ANY }}\n', ''), 'new.yml#extra (the workflow env reads secrets)'],
    ['the env override in the workflow env', newFile('permissions: write-all\nenv:\n  NPM_CONFIG_IGNORE_SCRIPTS: "false"\n', ''), 'new.yml#extra (a write token): NPM_CONFIG_IGNORE_SCRIPTS in an env block'],
    ['a job with a write token', newFile('permissions: {}\n', '    permissions:\n      issues: write\n'), 'new.yml#extra (a write token)'],
    ['a workflow-wide write token', newFile('permissions: write-all\n', ''), 'new.yml#extra (a write token)'],
    ['the default token', newFile('', ''), 'new.yml#extra (the default token)'],
    ['an environment by object', newFile('permissions: {}\n', '    environment:\n      name: anything\n'), 'new.yml#extra (an environment)'],
  ]
  for (const [name, files, reason] of cases) {
    test(name, () => {
      const { failures } = check(files)
      expect(failures.some(x => x.includes(reason)), `${reason} in ${JSON.stringify(failures)}`).toBe(true)
    })
  }
  test('a read-only job with no secret may run install scripts', () => {
    expect(check(newFile('permissions:\n  contents: read\n', '')).failures).toEqual([])
  })
})
