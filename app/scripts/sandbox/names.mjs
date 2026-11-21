// The sandbox name guard (P3 PR0 item 12): the ONE place that says which Cloudflare names a sandbox script may touch.
// The sandbox shares its account with live products, so every sandbox script (the config check's sandbox mode,
// seed-remote.mjs, and the ops repo's deploy and cleanup) calls this before any wrangler call, on every name it acts on.
//   - per-PR rule: `inhouse-sbx-pr<N>` and `inhouse-sbx-pr<N>-<word>` (N = 1..999999, no leading zero). The only names a
//     per-PR deploy or the cleanup may create or delete.
//   - sandbox-wide rule: `inhouse-sbx-<lowercase letters, digits, hyphens>`. Admits the per-PR names and the shared
//     sandbox resources (the candidate Worker, its D1 and R2), never a live product's name.
//   - eval rule (p3-eval-observability rev 2, rec 2): exactly the eval deployment's names, `inhouse-sbx-eval` and
//     `inhouse-sbx-eval-<db|files|brand|team>`. Disjoint from the per-PR rule (no `pr<N>`) and refused by the candidate
//     rule, so neither a PR's deploy or cleanup nor the candidate ever names the eval brand's resources. Its host rule
//     takes only the two host names (`-brand`, `-team`).
//   - host rule: `<name>.<zone>`, where <name> passes the rule asked for and <zone> is exactly the sandbox zone (one
//     label; a deeper host, the bare zone or another zone fails).
// JavaScript's `$` (no `m` flag) matches only at the very end, so a trailing newline fails; tests pin that.

export const PER_PR = /^inhouse-sbx-pr([1-9][0-9]{0,5})(-[a-z]+)?$/
export const SANDBOX_WIDE = /^inhouse-sbx-[a-z0-9-]+$/
const EVAL_WORKER = 'inhouse-sbx-eval'
/** A zone name as the sandbox's own variable gives it: lowercase labels, at least one dot, no trailing dot. */
const ZONE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

export class SandboxNameError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SandboxNameError'
  }
}

const show = v => JSON.stringify(v) ?? String(v)

export const isPerPrName = name => typeof name === 'string' && PER_PR.test(name)
export const isSandboxName = name => typeof name === 'string' && SANDBOX_WIDE.test(name)

/** The eval deployment's exact names (the same keys as perPrNames; the ops repo's eval deploy uses these). */
export function evalNames() {
  const worker = EVAL_WORKER
  return { worker, d1: `${worker}-db`, r2: `${worker}-files`, container: worker, image: worker, brand: `${worker}-brand`, team: `${worker}-team` }
}
export const isEvalName = name => typeof name === 'string' && Object.values(evalNames()).includes(name)

/** Throws unless `name` is one of the eval deployment's names. Returns the name. */
export function assertEvalName(name) {
  if (!isEvalName(name)) throw new SandboxNameError(`${show(name)} is not one of the eval deployment's names (${EVAL_WORKER}[-db|-files|-brand|-team])`)
  return name
}

/** The PR number a per-PR name belongs to, or null when it isn't one. */
export function prNumberOf(name) {
  if (typeof name !== 'string') return null
  const m = PER_PR.exec(name)
  return m ? Number(m[1]) : null
}

/** Throws unless `name` is a per-PR sandbox name (and, given `pr`, that PR's). Returns the name. */
export function assertPerPrName(name, pr) {
  const n = prNumberOf(name)
  if (n === null) throw new SandboxNameError(`${show(name)} is not a per-PR sandbox name (inhouse-sbx-pr<N>[-<word>])`)
  if (pr !== undefined && n !== pr) throw new SandboxNameError(`${show(name)} belongs to PR ${n}, not PR ${pr}`)
  return name
}

/** Throws unless `pr` is a PR number a per-PR name can carry (1..999999). Returns it. */
export function assertPrNumber(pr) {
  if (!Number.isInteger(pr) || pr < 1 || pr > 999_999) throw new SandboxNameError(`${show(pr)} is not a PR number (1 to 999999)`)
  return pr
}

/** The exact names of PR `pr`'s test deployment (the brief's naming; the ops repo's deploy and cleanup use these). */
export function perPrNames(pr) {
  assertPrNumber(pr)
  const worker = `inhouse-sbx-pr${pr}`
  return { worker, d1: `${worker}-db`, r2: `${worker}-files`, container: worker, image: worker, brand: `${worker}-brand`, team: `${worker}-team` }
}

/** Throws unless `name` is a shared sandbox name: sandbox-wide but no PR's and not the eval deployment's. Returns the name. */
export function assertCandidateName(name) {
  assertSandboxName(name)
  if (isPerPrName(name)) throw new SandboxNameError(`${show(name)} is a per-PR name, not the candidate's`)
  if (isEvalName(name)) throw new SandboxNameError(`${show(name)} is the eval deployment's name, not the candidate's`)
  return name
}

/** Throws unless `name` is a sandbox name (per-PR or shared). Returns the name. */
export function assertSandboxName(name) {
  if (!isSandboxName(name)) throw new SandboxNameError(`${show(name)} is not a sandbox name (inhouse-sbx-...)`)
  return name
}

/** Throws unless `zone` looks like a zone name. Returns it. */
export function assertZone(zone) {
  if (typeof zone !== 'string' || !ZONE.test(zone)) throw new SandboxNameError(`the sandbox zone ${show(zone)} is not a lowercase domain name`)
  return zone
}

/**
 * Throws unless `host` is `<name>.<zone>` with <name> passing `rule` ('per-pr', optionally for PR `pr`; 'sandbox';
 * 'candidate', a sandbox name that is no PR's and not the eval deployment's; or 'eval', the eval deployment's brand or
 * team host name).
 * Returns the host.
 */
export function assertSandboxHost(host, zone, rule, pr) {
  assertZone(zone)
  const suffix = `.${zone}`
  if (typeof host !== 'string' || !host.endsWith(suffix)) throw new SandboxNameError(`host ${show(host)} is not on the sandbox zone`)
  const label = host.slice(0, -suffix.length)
  try {
    if (rule === 'per-pr') assertPerPrName(label, pr)
    else if (rule === 'sandbox') assertSandboxName(label)
    else if (rule === 'candidate') assertCandidateName(label)
    else if (rule === 'eval') {
      const { brand, team } = evalNames()
      if (label !== brand && label !== team) throw new SandboxNameError(`${show(label)} is not one of the eval deployment's hosts (${brand}, ${team})`)
    }
    else throw new Error(`assertSandboxHost: unknown rule ${show(rule)}`)
  } catch (err) {
    if (err instanceof SandboxNameError) throw new SandboxNameError(`host ${show(host)}: ${err.message}`)
    throw err
  }
  return host
}
