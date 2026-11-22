// run.mjs's arguments, checked before anything runs (a pure function, so the unit tests cover it). Two modes:
//  - local (--persist-dir): the multi-config test build on this machine, restarted per case (--restart-cmd), read from its
//    local D1 file. MORNING_CHECK_RELEASE_JWT is required (route 67 moves the slot).
//  - remote (--target <origin>): a deployed test or eval build. The shop is the test shop override and the slot is read
//    through the door (door.ts), whose database and config come from INHOUSE_EVAL_D1_NAME, INHOUSE_EVAL_WRANGLER_CONFIG and
//    CF_SANDBOX_ACCOUNT_ID (wrangler reads CLOUDFLARE_API_TOKEN itself). MORNING_CHECK_RELEASE_JWT is optional: the eval
//    build has none, and without it there's no nudge.
// The modes' options are mutually exclusive: a remote run given a local option (or the reverse) is refused, never ignored.
import { DoorRefusal, EVAL_DB } from '../targets/door.ts'

export type RunArgs = Record<string, string | undefined>

const COMMON = ['out-dir', 'sha', 'issuer-key-file', 'aud'] as const
const LOCAL_ONLY = ['persist-dir', 'base-url', 'restart-cmd', 'shop-pattern', 'restart-wait-sec'] as const
const DOOR_ENV = ['INHOUSE_EVAL_D1_NAME', 'INHOUSE_EVAL_WRANGLER_CONFIG', 'CF_SANDBOX_ACCOUNT_ID'] as const

export type RunMode =
  | { mode: 'local'; baseUrl: string; persistDir: string; releaseJwt: string }
  | { mode: 'remote'; baseUrl: string; releaseJwt: string | null; database: string; wranglerConfig: string; modelSetting: { label: string; inhouseOrigin: string; inhouseAud: string } | null }

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

/**
 * Remote mode never runs on the eval deployment's shared database: the door (evals/targets/door.ts) now admits only
 * EVAL_DB, and a paid product eval may be running there, so a test-shop override set on it would break the one runner
 * per deployment rule. Throws DoorRefusal (run.mjs stops with exit 2 before any case). Line A's morning-check door rule
 * replaces this.
 */
export function refuseSharedEvalDb(database: string): void {
  if (database === EVAL_DB) throw new DoorRefusal(`refusing: ${EVAL_DB} is the eval deployment's shared database, and a paid product eval may be running on it (one runner per deployment)`)
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
    return { mode: 'remote', baseUrl: url.origin, releaseJwt, database: env.INHOUSE_EVAL_D1_NAME!, wranglerConfig: env.INHOUSE_EVAL_WRANGLER_CONFIG!, modelSetting }
  }
  for (const k of MODEL_SETTING) if (a[k] !== undefined) throw new Error(`run.mjs: --${k} is for a deployed build (--target) only`)
  for (const k of ['persist-dir', 'base-url'] as const) if (!a[k]) throw new Error(`run.mjs: --${k} is required (or --target for a deployed build)`)
  if (!releaseJwt) throw new Error('run.mjs: MORNING_CHECK_RELEASE_JWT is not set')
  return { mode: 'local', baseUrl: a['base-url']!, persistDir: a['persist-dir']!, releaseJwt }
}
