// Deploys PR N's test build to the sandbox from the folder deploy-config.mjs wrote (sandbox-test-deploy.yml's deploy job):
//   node scripts/sandbox/deploy.mjs --app <app main checkout>/app --pr <N> --deploy-dir <dir>
// Moved from the private ops repo's scripts/deploy.mjs (its per-PR mode only; the candidate and eval modes stay there).
// Env: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (must equal CF_SANDBOX_ACCOUNT_ID), CF_SANDBOX_ACCOUNT_ID, SBX_ZONE.
// In order, and no Cloudflare call before the first two pass:
//   1. both configs (<dir>/inhouse_product/wrangler.json, <dir>/migrate/wrangler.json) are read as plain JSON and pass the
//      lock (`--sandbox --per-pr N`) again, here, right before wrangler sees them;
//   2. every name this run touches is PR N's (perPrNames), checked again right before each call;
//   3. PR N's earlier deployment is torn down (teardown.mjs: its custom domains, Worker, hub, container application, D1,
//      R2, and its older runner image tags; the one this run pushed stays), so every deploy starts from an empty, freshly
//      seeded database;
//   4. its D1 and R2 are created (REST), `wrangler d1 migrations apply <d1> --remote` runs with the migrate config,
//      seed-remote.mjs seeds the invented brand, and `wrangler deploy` runs with the checked config and nothing on the
//      command line that could change it (no --name, --route, --var or --env).
// With a hub (<dir>/hub/wrangler.json, which deploy-config.mjs writes exactly when the product binds one), its config
// passes the lock in hub mode too, every product hub entry must name it, and `wrangler deploy` runs on the hub's config
// right before the product's, so the product's binding always has a Worker behind it.
// wrangler is main's own (the app checkout's node_modules), run by path with the app checkout as its working folder, so
// no local env file from the artifact can reach it. Exit 0 deployed, 1 refused or failed, 2 usage.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isHubSet } from './deploy-config.mjs'
import { cloudflare } from './cloudflare.mjs'
import { listAll, loadApp, planTeardown, runTeardown } from './teardown.mjs'

class Usage extends Error {}

/**
 * The hub's config in `dir`, when there is one, after the lock in hub mode; refuses unless the product config binds
 * exactly that hub (by `hubName`), and binds none when there is no hub. Returns the hub config's path or null.
 */
export function checkHub({ app, dir, product, hubName, accountId, zone, mode }) {
  const file = join(dir, 'hub', 'wrangler.json')
  const binds = (product.services ?? []).length > 0
  if (!existsSync(file)) {
    if (binds) throw new Error('the product binds a hub, but the deploy folder has none')
    return null
  }
  const config = app.readSandboxConfig(file)
  const failures = app.checkSandboxConfig(config, { accountId, zone, mode: { ...mode, hub: true }, configDir: resolve(file, '..') })
  if (failures.length) throw new Error(`${file} fails the lock:\n${failures.map(f => `  - ${f}`).join('\n')}`)
  if (config.name !== hubName) throw new Error(`${file} is not ${hubName}`)
  if (!binds || !isHubSet(product.services, hubName)) throw new Error(`the product doesn't bind ${hubName} (every hub entry must name it)`)
  return file
}

/** The tag of the runner image a checked product config names (`registry.cloudflare.com/<account>/<image>:<tag>`), or null. */
export function pushedImageTag(config) {
  const image = config.containers?.[0]?.image
  if (typeof image !== 'string') return null
  const m = /^registry\.cloudflare\.com\/[0-9a-f]{32}\/[a-z0-9-]+:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(image)
  if (!m) throw new Error(`the config's container image ${JSON.stringify(image)} is not a registry reference with a tag`)
  return m[1]
}

// The product Worker's deploy replaces its containers at once: wrangler's default is a gradual rollout (steps [10, 100], grace 0)
// that SIGTERMs old instances 1 to 2 minutes later, under live chat turns (developers.cloudflare.com/containers/configuration/rollouts).
const ROLLOUT = '--containers-rollout=immediate'

/**
 * The deploy, with its outside world injected: `cf` (cloudflare.mjs), `wrangler(args)` and `seed(args)` (each runs the
 * command and throws on a non-zero exit), `log`.
 */
export async function deploy({ app, pr, dir, accountId, zone, cf, wrangler, seed, log }) {
  const names = app.perPrNames(pr)
  const worker = join(dir, 'inhouse_product', 'wrangler.json')
  const migrate = join(dir, 'migrate', 'wrangler.json')
  // 1. The lock, on the files as they are now.
  const configs = []
  for (const file of [worker, migrate]) {
    const config = app.readSandboxConfig(file)
    const failures = app.checkSandboxConfig(config, { accountId, zone, mode: { perPr: pr }, configDir: resolve(file, '..') })
    if (failures.length) throw new Error(`${file} fails the lock:\n${failures.map(f => `  - ${f}`).join('\n')}`)
    if (config.name !== names.worker || config.d1_databases?.[0]?.database_name !== names.d1) throw new Error(`${file} is not PR ${pr}'s`)
    configs.push(config)
  }
  const hub = checkHub({ app, dir, product: configs[0], hubName: names.hub, accountId, zone, mode: { perPr: pr } })
  // 2 and 3. Tear down what's there, by exact name.
  const listing = await listAll(cf)
  // The image this deploy pushed (the checked config names it) stays; PR N's older tags go.
  const pushed = pushedImageTag(configs[0])
  const { deletions, skipped } = planTeardown(listing, [pr], { app, zone, keepImageTags: pushed ? [pushed] : [] })
  for (const s of skipped) log(`left alone: ${s.name} (${s.why})`)
  await runTeardown(cf, deletions, { app, zone, dryRun: false, log })
  // 4. Create, migrate, seed, deploy.
  app.assertPerPrName(names.d1, pr)
  await cf.createD1(names.d1)
  log(`created D1 ${names.d1}`)
  app.assertPerPrName(names.r2, pr)
  await cf.createR2(names.r2)
  log(`created R2 ${names.r2}`)
  wrangler(['d1', 'migrations', 'apply', names.d1, '--remote', '--config', migrate])
  seed(['--per-pr', String(pr), '--config', worker, '--database', names.d1])
  if (hub) {
    app.assertPerPrName(names.hub, pr)
    wrangler(['deploy', '--config', hub])
    log(`deployed the hub ${names.hub}`)
  }
  wrangler(['deploy', '--config', worker, ROLLOUT])
  log(`deployed ${names.worker} on https://${names.brand}.${zone} and https://${names.team}.${zone}`)
}

function parseArgs(argv) {
  const flags = {}
  for (let i = 0; i < argv.length; i += 2) {
    const name = /^--(app|pr|deploy-dir)$/.exec(argv[i])?.[1]
    if (!name || Object.hasOwn(flags, name) || i + 1 >= argv.length) throw new Usage(`unexpected argument ${JSON.stringify(argv[i])}`)
    flags[name] = argv[i + 1]
  }
  for (const k of ['app', 'deploy-dir']) if (!flags[k]) throw new Usage(`--${k} is required`)
  if (!/^[1-9][0-9]{0,5}$/.test(flags.pr ?? '')) throw new Usage('--pr must be a PR number')
  return flags
}

/** Runs node on `script` with `args` in the app checkout; throws on a non-zero exit. Output goes to the job log. */
function runNode(appDir, script, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: appDir, stdio: 'inherit', env })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${script.split('/').slice(-2).join('/')} ${args.slice(0, 2).join(' ')} exited ${r.status}`)
}

/**
 * Everything main() runs with, from its own arguments: the deploy's whole argument object, its wrangler and seed runners
 * included. main() only forwards it, so a test of mainParts is a test of main's wiring. `run` is for tests.
 */
export async function mainParts(argv, env, { run = runNode } = {}) {
  const f = parseArgs(argv)
  const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, CF_SANDBOX_ACCOUNT_ID: sandbox, SBX_ZONE: zone } = env
  if (!token || !accountId || accountId !== sandbox || !zone) throw new Usage('needs CLOUDFLARE_API_TOKEN, SBX_ZONE, and CLOUDFLARE_ACCOUNT_ID equal to CF_SANDBOX_ACCOUNT_ID')
  const appDir = resolve(f.app)
  const app = await loadApp(appDir)
  app.assertZone(zone)
  // Only what wrangler and seed-remote need; nothing else from this job's environment.
  const childEnv = { PATH: env.PATH, HOME: env.HOME, CI: 'true', CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, CF_SANDBOX_ACCOUNT_ID: sandbox, SBX_ZONE: zone, WRANGLER_SEND_METRICS: 'false' }
  return {
    app,
    pr: Number(f.pr),
    dir: resolve(f['deploy-dir']),
    accountId,
    zone,
    cf: cloudflare({ token, accountId }),
    wrangler: args => run(appDir, join(appDir, 'node_modules/wrangler/bin/wrangler.js'), args, childEnv),
    seed: args => run(appDir, join(appDir, 'scripts/sandbox/seed-remote.mjs'), args, childEnv),
    log: line => console.log(`deploy: ${line}`),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainParts(process.argv.slice(2), process.env).then(deploy).catch(err => {
    console.error(`deploy: ${err instanceof Usage ? 'usage: ' : ''}${err?.message ?? err}`)
    process.exitCode = err instanceof Usage ? 2 : 1
  })
}
