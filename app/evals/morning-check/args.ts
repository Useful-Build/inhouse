// run.mjs's arguments, checked before anything runs (a pure function, so the unit tests cover it). Two modes:
//  - local (--persist-dir): the multi-config test build on this machine, restarted per case (--restart-cmd), read from its
//    local D1 file. MORNING_CHECK_RELEASE_JWT is required (route 67 moves the slot).
//  - remote (--target <origin>): a deployed test or eval build. The shop is the test shop override and the slot is read
//    through the door (door.ts), whose database and config come from INHOUSE_EVAL_D1_NAME, INHOUSE_EVAL_WRANGLER_CONFIG and
//    CF_SANDBOX_ACCOUNT_ID (wrangler reads CLOUDFLARE_API_TOKEN itself). MORNING_CHECK_RELEASE_JWT is optional: the eval
//    build has none, and without it there's no nudge. The database (evals/targets/door.ts assertMorningCheckDatabase) is
//    a PR's test database (the scripted proof) or EVAL_DB (the graded run).
//  - graded (--target on EVAL_DB, the eval deployment, behind Access): INHOUSE_EVAL_ACCESS_CLIENT_ID and _SECRET both set
//    (every request carries them: targets/product.ts accessHeaders), --budget <usd> (above zero, at most
//    MORNING_CHECK_CAP), --model mapped to the product's Default model label (server/model/catalog.ts), no --model-setting
//    (the door sets the Default model) and no MORNING_CHECK_RELEASE_JWT (route 67 is the per-PR test deploy's).
//    Elsewhere the Access token is refused unless both are set, the release token is refused beside it, and --budget is
//    refused.
// The modes' options are mutually exclusive: a remote run given a local option (or the reverse) is refused, never ignored.
import { DoorRefusal, EVAL_DB } from '../targets/door.ts'
import { EVAL_ACCESS_CLIENT_ID_VAR, EVAL_ACCESS_CLIENT_SECRET_VAR, EVAL_CAP } from '../targets/product.ts'
import { CATALOG } from '../../server/model/catalog.ts'

export type RunArgs = Record<string, string | undefined>

const COMMON = ['out-dir', 'sha', 'issuer-key-file', 'aud'] as const
const LOCAL_ONLY = ['persist-dir', 'base-url', 'restart-cmd', 'shop-pattern', 'restart-wait-sec'] as const
const DOOR_ENV = ['INHOUSE_EVAL_D1_NAME', 'INHOUSE_EVAL_WRANGLER_CONFIG', 'CF_SANDBOX_ACCOUNT_ID'] as const

/** The graded run's settings: the --budget in dollars and the Default model label --model maps to. */
export interface Graded { budgetUsd: number; label: string }

export type RunMode =
  | { mode: 'local'; baseUrl: string; persistDir: string; releaseJwt: string }
  | { mode: 'remote'; baseUrl: string; releaseJwt: string | null; database: string; wranglerConfig: string; modelSetting: { label: string; inhouseOrigin: string; inhouseAud: string } | null; access: boolean; graded: Graded | null }

const MODEL_SETTING = ['model-setting', 'inhouse-origin', 'inhouse-aud'] as const

/**
 * --model-setting writes the brand's Default model (`g:mode`, route 12). An Admin may write only `tm:<id>:on` there
 * (server/auth/matrix.ts: anything else is 403 admin_read_only); `g:mode` takes the Inhouse team member, signed in on the
 * build's Inhouse app. So it needs that app's origin (--inhouse-origin) and Access aud (--inhouse-aud), and those go with
 * it only.
 */
function remoteModelSetting(a: RunArgs): { label: string; inhouseOrigin: string; inhouseAud: string } | null {
  const label = a['model-setting']
  if (label === undefined) {
    const extra = MODEL_SETTING.filter(k => a[k] !== undefined)
    if (extra.length) throw new Error(`run.mjs: ${extra.map(k => `--${k}`).join(', ')} only go with --model-setting`)
    return null
  }
  if (!/^[A-Za-z]{1,20}$/.test(label)) throw new Error('run.mjs: --model-setting must be a Default model label (Fast, say)')
  const origin = a['inhouse-origin']
  const aud = a['inhouse-aud']
  if (!origin || !aud) throw new Error('run.mjs: --model-setting needs --inhouse-origin and --inhouse-aud (g:mode is written by the Inhouse team member, on the Inhouse app)')
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new Error('run.mjs: --inhouse-origin must be the build\'s Inhouse app https origin')
  }
  if (url.protocol !== 'https:' || url.origin !== origin.replace(/\/$/, '')) throw new Error('run.mjs: --inhouse-origin must be the build\'s Inhouse app https origin (no path, query or credentials)')
  return { label, inhouseOrigin: url.origin, inhouseAud: aud }
}

/** Whether the Access service token is set: both (true), neither (false), or a refusal naming the variables (never a value). */
function accessSet(env: Record<string, string | undefined>): boolean {
  const id = env[EVAL_ACCESS_CLIENT_ID_VAR]
  const secret = env[EVAL_ACCESS_CLIENT_SECRET_VAR]
  if (!id && !secret) return false
  if (!id || !secret) throw new Error(`run.mjs: ${EVAL_ACCESS_CLIENT_ID_VAR} and ${EVAL_ACCESS_CLIENT_SECRET_VAR} are not both set, so the eval host's Access lock would refuse every call`)
  return true
}

/** The product's Default model label for an API model id (the catalogue's picker label: claude-sonnet-5-5 is "Fast"), or a refusal. */
export function defaultModelLabel(model: string | undefined): string {
  const label = CATALOG.find(m => m.apiId === model)?.label
  if (!label) throw new Error(`run.mjs: --model ${JSON.stringify(model)} is no model the product serves, so the brand's Default model can't be set to it`)
  return label
}

/** --budget for the graded run: dollars above zero, at most the eval brand's cap (MORNING_CHECK_CAP). */
function budgetOf(raw: string | undefined): number {
  const capUsd = Number(EVAL_CAP.slice(1))
  const usd = raw === undefined || !/^\d+(\.\d{1,2})?$/.test(raw) ? NaN : Number(raw)
  if (!(usd > 0)) throw new Error('run.mjs: the graded run (EVAL_DB) needs --budget <usd> above zero: it stops before the next case once the run has spent it')
  if (usd > capUsd) throw new Error(`run.mjs: --budget $${raw} is above the eval brand's ${EVAL_CAP} cap`)
  return usd
}

/**
 * The scripted proof (e2e/api/morning-check-remote.spec.ts) never runs on the eval deployment's shared database: it writes
 * the Default model as Fast for the scripted model, and the eval deployment runs the real one (run.mjs's graded run).
 * Throws DoorRefusal before any write.
 */
export function refuseSharedEvalDb(database: string): void {
  if (database === EVAL_DB) throw new DoorRefusal(`refusing: ${EVAL_DB} is the eval deployment's shared database, where the real model runs (run.mjs's graded run), never the scripted proof`)
}

export function runMode(a: RunArgs, env: Record<string, string | undefined>): RunMode {
  for (const k of COMMON) if (!a[k]) throw new Error(`run.mjs: --${k} is required`)
  const releaseJwt = env.MORNING_CHECK_RELEASE_JWT || null
  if (a.target !== undefined) {
    const local = LOCAL_ONLY.filter(k => a[k] !== undefined)
    if (local.length) throw new Error(`run.mjs: --target (remote) can't be used with ${local.map(k => `--${k}`).join(', ')}`)
    let url: URL
    try {
      url = new URL(a.target)
    } catch {
      throw new Error('run.mjs: --target must be the deployed build\'s https origin')
    }
    if (url.protocol !== 'https:' || url.origin !== a.target.replace(/\/$/, '')) throw new Error('run.mjs: --target must be the deployed build\'s https origin (no path, query or credentials)')
    const missing = DOOR_ENV.filter(k => !env[k])
    if (missing.length) throw new Error(`run.mjs: --target reads the build's D1 through the door and needs ${missing.join(', ')}`)
    const modelSetting = remoteModelSetting(a)
    const access = accessSet(env)
    if (access && releaseJwt) throw new Error('run.mjs: MORNING_CHECK_RELEASE_JWT is for a per-PR test deploy (route 67): the Access-locked eval host takes no release token, and Run now pokes the scheduler itself')
    const database = env.INHOUSE_EVAL_D1_NAME!
    let graded: Graded | null = null
    if (database === EVAL_DB) {
      if (!access) throw new Error(`run.mjs: the graded run (${EVAL_DB}) goes to the Access-locked eval host: set ${EVAL_ACCESS_CLIENT_ID_VAR} and ${EVAL_ACCESS_CLIENT_SECRET_VAR}`)
      if (modelSetting) throw new Error('run.mjs: the graded run sets the Default model from --model through the door: --model-setting is for a per-PR scripted run')
      graded = { budgetUsd: budgetOf(a.budget), label: defaultModelLabel(a.model) }
    } else if (a.budget !== undefined) {
      throw new Error(`run.mjs: --budget is for the graded run (${EVAL_DB}) only`)
    }
    return { mode: 'remote', baseUrl: url.origin, releaseJwt, database, wranglerConfig: env.INHOUSE_EVAL_WRANGLER_CONFIG!, modelSetting, access, graded }
  }
  if (accessSet(env)) throw new Error(`run.mjs: ${EVAL_ACCESS_CLIENT_ID_VAR} and ${EVAL_ACCESS_CLIENT_SECRET_VAR} are for a deployed build behind Access (--target) only`)
  if (a.budget !== undefined) throw new Error(`run.mjs: --budget is for the graded run (${EVAL_DB}) only`)
  for (const k of MODEL_SETTING) if (a[k] !== undefined) throw new Error(`run.mjs: --${k} is for a deployed build (--target) only`)
  for (const k of ['persist-dir', 'base-url'] as const) if (!a[k]) throw new Error(`run.mjs: --${k} is required (or --target for a deployed build)`)
  if (!releaseJwt) throw new Error('run.mjs: MORNING_CHECK_RELEASE_JWT is not set')
  return { mode: 'local', baseUrl: a['base-url']!, persistDir: a['persist-dir']!, releaseJwt }
}
