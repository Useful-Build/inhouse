// The Dynamic Worker's code and the checks on what comes back (P5 W2, A.3). Plain logic so the Node project tests it.
// - Two modules: `user.js` is the model's function body inside `export default async (shop) => { ... }`; `script.js`
//   is fixed, imports it and returns JSON.stringify of its result. Workers forbid code generation from strings, so the
//   code is module source, never evaluated at runtime.
// - The id is `cm1-` + SHA-256 of WRAPPER_VERSION and the code alone (the loader's "same id, same code" rule, and the
//   pricing's count per id): never a run id, a time or a random value. Nothing per call is in `env`.
// - The hub trusts nothing the sandbox returns: a string of at most MAX_RETURN_BYTES (UTF-8), parsed here. The wrapper
//   refuses a non-string or over-long return before it crosses (review round 1 L1); the hub's check stays.
import { COMPATIBILITY_DATE, MAX_ERROR_CHARS, MAX_RETURN_BYTES } from './caps'

export const WRAPPER_VERSION = 3

export const BAD_RETURN = 'script must return a small JSON value'

export const WRAPPER = `import { WorkerEntrypoint } from 'cloudflare:workers'
import script from './user.js'

export class Script extends WorkerEntrypoint {
  async run(shop) {
    const result = await script(shop)
    const s = JSON.stringify(result === undefined ? null : result)
    // A big or non-string return never crosses into the hub (which checks again).
    if (typeof s !== 'string' || s.length > ${MAX_RETURN_BYTES}) throw new Error('${BAD_RETURN}')
    return s
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 })
  },
}
`

export const userModule = (code: string): string => `export default async (shop) => {\n${code}\n}\n`


async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** The loader id: a pure function of the code and WRAPPER_VERSION. */
export const scriptId = async (code: string): Promise<string> => `cm1-${await sha256Hex(`${WRAPPER_VERSION}\n${code}`)}`

/** The first 12 hex of the id's hash, for the log line. */
export const codeHashForLog = (id: string): string => id.slice(4, 16)

/** Exactly the same WorkerCode for the same code: no network, nothing in env. */
export const workerCode = (code: string): WorkerLoaderWorkerCode => ({
  compatibilityDate: COMPATIBILITY_DATE,
  mainModule: 'script.js',
  modules: { 'script.js': WRAPPER, 'user.js': userModule(code) },
  // fetch() and connect() throw (Dynamic Workers egress control).
  globalOutbound: null,
  env: {},
})

export type ReadReturn = { ok: true; value: unknown } | { ok: false }

/** The sandbox's return value: a string, at most MAX_RETURN_BYTES, checked before JSON.parse. Anything else fails. */
export function readReturn(v: unknown): ReadReturn {
  if (typeof v !== 'string') return { ok: false }
  // A UTF-16 length over the cap is over it in UTF-8 too: skip encoding a huge string.
  if (v.length > MAX_RETURN_BYTES || new TextEncoder().encode(v).byteLength > MAX_RETURN_BYTES) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(v) as unknown }
  } catch {
    return { ok: false }
  }
}

/** A script failure as the model sees it: `<name>: <message>`, at most MAX_ERROR_CHARS. Only string fields are read. */
export function errorText(e: unknown): string {
  let name = 'Error'
  let message = 'script failed'
  if (typeof e === 'object' && e !== null) {
    try {
      const n = (e as { name?: unknown }).name
      const m = (e as { message?: unknown }).message
      if (typeof n === 'string' && n.length > 0) name = n
      if (typeof m === 'string') message = m
    } catch {
      // A getter that throws: keep the fixed text.
    }
  }
  const text = `${name}: ${message}`
  return text.length > MAX_ERROR_CHARS ? text.slice(0, MAX_ERROR_CHARS) : text
}
