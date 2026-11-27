// The gate check's rules (Part 3 and Part 4 Q2 of the test and merge policy). Pure: no I/O. run.mjs reads the PR
// through the GitHub API and hands it here; .github/workflows/gate.yml runs run.mjs from main, never from the PR.
//
// The lanes: 1 Low and 2 Normal can't be told apart by path, so they are reported together as "Lane 1/2". Lane 3
// (High) is a path list: two AI reviewers, no human. Lane 4 needs Wasim's OK: the referee (CI, test, lint and type
// configs, existing check scripts, any check-weakening pattern), the rules (AGENTS.md, REVIEW.md, VERIFY.md,
// docs/decisions), secrets and trust boundaries, dependencies, and irreversible jobs. Ledger items (new migrations, route
// changes, egress hosts, write ops) pass on two reviewer "Gate check: on ledger" lines, or become Lane 4 on a
// "Gate check: off ledger" line. When a rule can't be sure, it flags, and says why.
//
// Inputs are GitHub's PR file objects ({ filename, status, previous_filename, patch, changes }); a changed package.json
// also carries `before` and `after` (its text at the merge base and at the head, null when absent).

export const APPROVAL_LABEL = 'wasim-approved'
/** Comment authors whose "Gate check:" and "wasim-approved:" lines count (the repo is public: anyone else's are ignored). */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
export const GATE_CHECKS_NEEDED = 2
/** Property tests below this many runs are check-weakening when added. */
export const MIN_NUM_RUNS = 100

export const isTestFile = path => /\.(test|spec)\.[^/]+$/.test(path)
/** Test code outside test files: kits and helpers in testing folders. */
const inTestingDir = path => /(?:^|\/)testing\//.test(path)
const LINT_CONFIG = /(?:^|\/)(?:\.?oxlintrc[^/]*|\.?eslintrc[^/]*|(?:eslint|oxlint)\.config\.[^/]+)$/
const TS_CONFIG = /(?:^|\/)tsconfig[^/]*\.json$/
const TEST_CONFIG = /(?:^|\/)(?:playwright|vitest)\.config\.[cm]?[jt]s$/
/** Where numeric loosening counts: tests, specs, e2e code, test folders, and test, lint and type configs. */
export const isCheckFile = path => isTestFile(path) || TEST_CONFIG.test(path) || LINT_CONFIG.test(path) || TS_CONFIG.test(path) ||
  /^app\/e2e\//.test(path) || /(?:^|\/)(?:test|tests|testing|__tests__)\//.test(path)

/** Lane 4 by path alone (any status). Order matters only for the reason shown. */
const LANE4_PATHS = [
  [/^\.github\//, 'the referee: CI workflows and repo settings'],
  [/^app\/(?:hub\/|runner\/)?(?:playwright|vitest)\.config\.[cm]?[jt]s$/, 'the referee: a test config'],
  [LINT_CONFIG, 'the referee: a lint config'],
  [TS_CONFIG, 'the referee: a TypeScript config'],
  [/^app\/scripts\/sandbox\//, 'secrets: the sandbox deploy scripts'],
  [/^(?:AGENTS|REVIEW|VERIFY)\.md$/, 'the rules'],
  [/^docs\/decisions\//, 'the rules: a decision record'],
  [/^app\/server\/auth\//, 'trust boundary: auth'],
  [/^app\/hub\/(?:signin|crypto|scope|testing)\//, 'trust boundary: the hub'],
  [/^app\/runner\/src\/(?:guards|proxy)\//, 'trust boundary: the runner'],
  [/^app\/shared\/security-headers\.ts$/, 'trust boundary: security headers'],
  [/^app\/public\/_headers$/, 'trust boundary: security headers'],
  [/^app\/vite\.config\.ts$/, 'trust boundary: the build seams'],
  [/^app\/wrangler[^/]*\.jsonc$/, 'trust boundary: a Worker config'],
  [/^app\/worker\//, 'trust boundary: the Worker'],
  [/^app\/ops\/(?:backup|restore|retention|export|delete|teardown)\//, 'irreversible: a backup, restore, retention, export, deletion or teardown job'],
  [/(?:^|\/)package-lock\.json$/, 'dependency change'],
]

/** Lane 3 by path (any status). Check-weakening in these files is still Lane 4. */
const LANE3_PATHS = [
  /^app\/server\/(?:egress|permissions|outbox|usage|notify-slack|prompt|migrations)\//,
  /^app\/server\/do\/brand-agent\//,
  /^app\/server\/(?:routes|access-matrix)\.ts$/,
  /^app\/hub\/outbox-entry\//,
  /^app\/hub\/connectors\/[^/]+\/write\//,
  /^app\/e2e\//,
  /^app\/ops\//,
  /\.property\.test\.ts$/,
]

const MIGRATIONS = /^app\/server\/migrations\//
const ROUTES = /^app\/server\/(?:routes|access-matrix)\.ts$/
const EGRESS_CODE = /^app\/(?:server\/egress|hub\/connectors)\//
const WRITE_OPS = /^app\/(?:hub\/connectors\/[^/]+\/write|server\/outbox\/operations)\//
/** The check scripts folders: existing files there are the referee. */
const SCRIPTS = /^app\/(?:hub\/|runner\/|runner\/harness\/)?scripts\//
const PACKAGE_JSON = /(?:^|\/)package\.json$/
const DOCKERFILE = /(?:^|\/)Dockerfile(?:\.(?!dockerignore$)[^/]*)?$/

/** Statuses that make a new file at `filename` (a rename counts only when it moves in from elsewhere). */
const isNew = (f, dir) => f.status === 'added' || f.status === 'copied' || (f.status === 'renamed' && !dir.test(f.previous_filename ?? ''))

/**
 * A unified-diff patch (GitHub's `patch`: hunks only) as hunks: `lines` is the new file's view (context and added lines,
 * as { line, text, added }), `old` the old file's view ({ text, removed }), `added` ([{ line, text }]), `removed` ([text]).
 */
export function parsePatch(patch) {
  const hunks = []
  let hunk = null
  let next = 0
  for (const raw of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (h) { hunk = { lines: [], old: [], added: [], removed: [] }; hunks.push(hunk); next = Number(h[1]); continue }
    if (!hunk) continue
    const text = raw.slice(1)
    if (raw.startsWith('+')) {
      hunk.added.push({ line: next, text })
      hunk.lines.push({ line: next++, text, added: true })
    } else if (raw.startsWith('-')) {
      hunk.removed.push(text)
      hunk.old.push({ text, removed: true })
    } else if (!raw.startsWith('\\')) {
      hunk.lines.push({ line: next++, text, added: false })
      hunk.old.push({ text, removed: false })
    }
  }
  return hunks
}

// ---- A small expression reader --------------------------------------------------------------------------------------

/** Skips a string or template starting at text[i]; returns the index of its closing quote, or -1 when it doesn't close. */
function skipString(text, i) {
  const q = text[i]
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') { j++; continue }
    if (text[j] === q) return j
    if (q === '`' && text[j] === '$' && text[j + 1] === '{') {
      const end = skipExpr(text, j + 2, '}')
      if (end < 0) return -1
      j = end
      continue
    }
    if (q !== '`' && text[j] === '\n') return -1
  }
  return -1
}

/** Reads from text[i] to the bracket `close` at depth 0; returns its index, or -1 (no close, or a comment or regex). */
function skipExpr(text, i, close) {
  let depth = 0
  for (let j = i; j < text.length; j++) {
    const c = text[j]
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(text, j)
      if (end < 0) return -1
      j = end
    } else if (c === '/') return -1
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) return c === close ? j : -1
      depth--
    }
  }
  return -1
}

/**
 * The top-level arguments of a call whose `(` is at text[open], as trimmed source strings; or { unsure } when the call
 * doesn't close in the text given or holds something the reader won't guess at (a comment or a regex).
 */
export function callArgs(text, open) {
  const end = skipExpr(text, open + 1, ')')
  if (end < 0) return { unsure: text.slice(open).includes('/') ? 'a comment or regex in its arguments' : "its arguments don't close where the diff shows them" }
  const args = []
  let depth = 0
  let start = open + 1
  for (let j = open + 1; j < end; j++) {
    const c = text[j]
    if (c === "'" || c === '"' || c === '`') j = skipString(text, j)
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (c === ',' && depth === 0) { args.push(text.slice(start, j).trim()); start = j + 1 }
  }
  // A trailing comma leaves no argument.
  const last = text.slice(start, end).trim()
  if (last) args.push(last)
  return { args }
}

const STRING_LITERAL = /^(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\$]|\$(?!\{))*`)$/
/** A literal: its value is fixed, so a condition made of one is no condition. */
const LITERAL = /^!*\s*(?:true|false|null|undefined|NaN|-?\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\$]|\$(?!\{))*`|\[\s*\]|\{\s*\})$/
const isFunction = arg => /^(?:async\b|function\b)/.test(arg) || /^(?:\([^]*?\)|[\w$]+)\s*=>/.test(arg)

// ---- Skips ----------------------------------------------------------------------------------------------------------
// A skip that removes a test is check-weakening: a skipped, todo or expected-to-fail declaration (`test.skip('t', fn)`,
// `it.todo('t')`, `it.fails('t', fn)`, `it.skip.each(...)`), an unconditional call (`test.skip()`, `test.skip(true)`, any
// literal first argument, `it.skipIf(1)`, `it.runIf(false)`), and a skip picked by a literal condition
// (`(true ? test.skip : test)`). A conditional skip is not: a first argument that isn't a literal (an identifier, a call,
// a negation, a Playwright callback), whatever the reason after it, and a test picked by a real condition
// (`(cond ? test : test.skip)('t', fn)`). Only `test`, `it` and `describe` chains count (`tour.skip()` is app code).

const CHAIN = /(?<![\w$.])(test|it|describe)((?:\s*\.\s*[A-Za-z_$][\w$]*)+)/g
const SKIP_MEMBERS = new Set(['skip', 'fixme', 'fail', 'fails', 'todo'])
const IF_MEMBERS = new Set(['skipIf', 'runIf'])

function describeSkip(member) {
  if (member === 'todo') return 'a todo test (.todo)'
  if (member === 'fails' || member === 'fail') return `an expected-to-fail test (.${member})`
  return `a skipped test or suite (.${member})`
}

/** The condition before the `?` of the ternary a value sits in (the text after the last `(`, `=`, `,`, `;` or return). */
const ternaryCondition = before => before.slice(0, before.lastIndexOf('?')).replace(/^[^]*(?:[(=,;]|\breturn\b)/, '').trim()

/**
 * Why the new-file line at view[i] weakens a check by skipping, or null. `view` is the hunk's new-file lines (context and
 * added), so a call that spans lines is read with the lines after it.
 */
export function skipIn(view, i) {
  const text = view[i].text
  if (/\b(?:oxlint|eslint)-disable/.test(text)) return 'a lint disable comment'
  if (/@ts-nocheck\b/.test(text)) return 'a @ts-nocheck'
  for (const m of text.matchAll(CHAIN)) {
    const members = m[2].split('.').map(s => s.trim()).filter(Boolean)
    const at = members.findIndex(x => SKIP_MEMBERS.has(x) || IF_MEMBERS.has(x))
    if (at < 0) continue
    const member = members[at]
    const name = `.${member}`
    // `it.skip.each(...)`, `test.describe.skip.serial(...)`: a skipped declaration.
    if (at < members.length - 1) return describeSkip(member)
    const afterChain = m.index + m[0].length
    const rest = text.slice(afterChain)
    if (rest.trimStart().startsWith('(')) {
      // Read the call with the lines after it (up to 30), so arguments split over lines are seen whole.
      const joined = [text, ...view.slice(i + 1, i + 31).map(l => l.text)].join('\n')
      const call = callArgs(joined, afterChain + rest.indexOf('('))
      if (call.unsure) return `a ${name}( call (kept: ${call.unsure}, so it can't be read as conditional)`
      const [first, ...others] = call.args
      if (IF_MEMBERS.has(member)) {
        if (first === undefined || LITERAL.test(first)) return `a ${name}( with a literal condition (${first ?? 'none'})`
        continue
      }
      if (first === undefined) return `an unconditional skip (${name}())`
      if (first === '...') return `a ${name}( with its first argument left out (kept: can't tell it's conditional)`
      // A string title, a template with ${} included (a string is never a condition), declares a test.
      if (STRING_LITERAL.test(first) || first.startsWith('`')) return describeSkip(member)
      if (LITERAL.test(first)) return `an unconditional skip (${name}(${first}))`
      // A condition takes one reason at most; more arguments, or a function after the first, declare a test.
      if (!isFunction(first) && (others.length > 1 || others.some(isFunction))) return `${describeSkip(member)} whose title isn't a string literal`
      continue
    }
    // A value: only a test picked by a real condition (`cond ? test : test.skip`) is conditional.
    const before = text.slice(0, m.index)
    if (/[?:]\s*$/.test(before) && before.includes('?')) {
      const cond = ternaryCondition(before)
      if (LITERAL.test(cond)) return `a ${name} picked by a literal condition (${cond})`
      continue
    }
    return `a ${name} used as a value (kept: can't tell it's conditional)`
  }
  return null
}

// ---- Numeric settings -----------------------------------------------------------------------------------------------
// In check files only (tests, specs, e2e code, test folders, test, lint and type configs): a raised timeout, retries,
// retry, threshold, maxDiffPixels or maxDiffPixelRatio (matched by key suffix: testTimeout counts), a lowered numRuns, an
// added or raised test.setTimeout, an added retries or retry above 0 (exact keys), an added threshold, maxDiffPixels or maxDiffPixelRatio, and an added numRuns below 100.
// Values are read as numbers or products of numbers (`60 * 1000`, `60_000`); a changed value that can't be read is
// flagged. Product code (`MAX_INFRA_RETRIES = 3`, a busy_timeout) is not a check file and never counts.

const LOOSEN_KINDS = ['maxdiffpixelratio', 'maxdiffpixels', 'threshold', 'retries', 'retry', 'timeout', 'numruns']
const kindOf = key => LOOSEN_KINDS.find(k => key.toLowerCase().endsWith(k)) ?? null
/** Keys that are check-weakening as soon as they're added (exact names: `lowStockThreshold` in a fixture is not). */
const NEW_IS_LOOSER = new Set(['maxDiffPixels', 'maxDiffPixelRatio', 'threshold'])
const SETTING = /([A-Za-z_$][\w$]*)\s*(?::|(?<![=!<>])=(?![=>]))\s*/g
const SET_TIMEOUT = /(?<![\w$.])((?:test|testInfo)\.setTimeout)\s*\(/g

/** A number, or a product of numbers; null when it can't be read. */
export function evaluate(expr) {
  const parts = expr.split('*').map(p => p.trim().replace(/^\((.*)\)$/, '$1').trim())
  if (!parts.every(p => /^\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(p))) return null
  return parts.reduce((a, p) => a * Number(p.replaceAll('_', '')), 1)
}
/** A value that is certainly not a number: a function, a string, a boolean, an object or array literal, a type. */
const notNumber = v => isFunction(v) || STRING_LITERAL.test(v) || /^(?:true|false|null|undefined)$/.test(v) || /^[[{]/.test(v) ||
  /^(?:number|string|boolean|bigint|unknown|any|never|void)\b/.test(v)

/** Each loosening setting on a line, in order: [{ key, kind, raw, value }] (value null when it can't be read). */
function settings(line) {
  if (/^\s*(?:\*|\/\*|\/\/|#)/.test(line)) return []
  const text = line.replace(/(^|\s)\/\/.*$/, '$1')
  const out = []
  for (const m of text.matchAll(SETTING)) {
    const kind = kindOf(m[1])
    if (!kind) continue
    const start = m.index + m[0].length
    // The value runs to the next top-level , ; ) } ] or the end of the line.
    let depth = 0
    let j = start
    for (; j < text.length; j++) {
      const c = text[j]
      if (c === "'" || c === '"' || c === '`') { const e = skipString(text, j); if (e < 0) { j = text.length; break } j = e; continue }
      if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) { if (depth === 0) break; depth-- }
      else if ((c === ',' || c === ';') && depth === 0) break
    }
    const raw = text.slice(start, j).trim()
    if (!raw || notNumber(raw)) continue
    const value = evaluate(raw)
    // Options are passed as properties (`retries: n`); an assignment (`const retry = toolOf(...)`) counts only with a
    // number, since an unreadable one is a local variable, not a setting.
    if (value === null && !m[0].includes(':')) continue
    out.push({ key: m[1], kind, raw, value })
  }
  for (const m of text.matchAll(SET_TIMEOUT)) {
    const call = callArgs(text, m.index + m[0].length - 1)
    const raw = call.unsure ? '(unreadable)' : (call.args[0] ?? '')
    out.push({ key: m[1], kind: 'timeout', raw, value: evaluate(raw), setTimeout: true })
  }
  return out
}

/** The check-weakening items in one hunk of a check file: loosened numeric settings. */
function loosenedIn(hunk) {
  const found = []
  const removed = new Map()
  for (const text of hunk.removed) for (const s of settings(text)) removed.set(s.key, [...(removed.get(s.key) ?? []), s])
  for (const { line, text } of hunk.added) {
    for (const s of settings(text)) {
      const was = removed.get(s.key)?.shift()
      const at = `(line ${line})`
      if (was) {
        if (was.raw === s.raw) continue
        if (s.value === null || was.value === null) { found.push(`check-weakening: ${s.key} changed to a value that can't be read (${s.raw}) ${at}`); continue }
        const loosened = s.kind === 'numruns' ? s.value < was.value : s.value > was.value
        if (loosened) found.push(`check-weakening: ${s.key} ${s.kind === 'numruns' ? 'lowered' : 'raised'} from ${was.raw} to ${s.raw} ${at}`)
        continue
      }
      // Added with nothing removed.
      if (s.setTimeout) found.push(`check-weakening: adds ${s.key}(${s.raw}) ${at}`)
      else if (s.key === 'retries' || s.key === 'retry') {
        if (s.value === null) found.push(`check-weakening: adds ${s.key} with a value that can't be read (${s.raw}) ${at}`)
        else if (s.value > 0) found.push(`check-weakening: ${s.key} raised from 0 to ${s.raw} ${at}`)
      } else if (NEW_IS_LOOSER.has(s.key)) found.push(`check-weakening: adds ${s.key}: ${s.raw} ${at}`)
      else if (s.key === 'numRuns' && (s.value === null || s.value < MIN_NUM_RUNS)) {
        found.push(`check-weakening: adds numRuns: ${s.raw}, ${s.value === null ? "a value that can't be read" : `below ${MIN_NUM_RUNS}`} ${at}`)
      }
    }
  }
  return found
}

// ---- Test counts ----------------------------------------------------------------------------------------------------

const TEST_DECL = /(?<![\w$.])(?:test|it|describe)(?:\.describe)?(?:\.(?:serial|parallel|concurrent|sequential|only))?\s*\(/g
const countDecls = lines => lines.reduce((n, text) => n + [...text.matchAll(TEST_DECL)].length, 0)

// ---- Hosts ----------------------------------------------------------------------------------------------------------
// A host is a quoted string with a URL scheme, or a dotted name ending in a common top-level domain (dotted event names
// like 'egress.denied' and file names like './x.ts' are not hosts).
const TLDS = new Set(('com net org io dev app co ai cloud shop store me info biz xyz tech so sh gg ly to tv fm us uk ca au de fr nl eu jp in ' +
  'es it se ch no dk fi pl br mx nz ie be at pt site online page link run host email').split(' '))
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g
const HOST = /^(?:(?:https?|wss?):\/\/)?(?:\*\.|\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]{0,62}))(?::\d+)?(?:[/?#].*)?$/i
const HOST_LIST = /allowedHosts|\bhosts\b|HOSTS/

function hostOf(s) {
  const m = HOST.exec(s)
  if (!m) return null
  if (!/^(?:https?|wss?):\/\//i.test(s) && !TLDS.has(m[2].toLowerCase())) return null
  return m[1].toLowerCase()
}

// ---- Packages and Dockerfiles ---------------------------------------------------------------------------------------

const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']
const sortedJson = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))
const differs = (before, after, key) => sortedJson(before?.[key] ?? null) !== sortedJson(after?.[key] ?? null)

/** A package.json's Lane 4 reasons: its dependency blocks or its scripts (the lint, typecheck and test commands) changed. */
function packageChanges(f) {
  if (f.before === undefined || f.after === undefined) throw new Error(`${f.filename}: the package.json text (before and after) wasn't fetched`)
  let before, after
  try {
    before = f.before === null ? {} : JSON.parse(f.before)
    after = f.after === null ? {} : JSON.parse(f.after)
  } catch {
    return ['dependency change: a package.json that can\'t be read']
  }
  const reasons = []
  if (DEP_KEYS.some(k => differs(before, after, k))) reasons.push('dependency change')
  if (differs(before, after, 'scripts')) reasons.push('test or lint command change')
  return reasons
}

const INSTALLS = /\b(?:apt-get\s+(?:-\S+\s+)*install|apt\s+install|apk\s+(?:-\S+\s+)*add|npm\s+(?:ci|install|i)\b|pip3?\s+install|yarn\s+(?:add|install)|pnpm\s+(?:add|install|i)\b)/

/**
 * Whether a Dockerfile hunk view changes an instruction that installs packages. Lines joined by a trailing `\` are one
 * instruction; a changed line in an instruction that may have begun above the hunk can't be judged, so it's flagged.
 */
function dockerInstallChange(view, changed) {
  const instructions = []
  let inst = []
  for (const l of view) {
    inst.push(l)
    if (!/\\\s*$/.test(l.text)) { instructions.push(inst); inst = [] }
  }
  if (inst.length) instructions.push(inst)
  return instructions.some((ins, n) => {
    if (!ins.some(l => l[changed])) return false
    if (INSTALLS.test(ins.map(l => l.text).join('\n'))) return true
    return n === 0 && /^\s/.test(ins[0].text) && !/^\s*(?:#|$)/.test(ins[0].text)
  })
}

// ---- One file -------------------------------------------------------------------------------------------------------

// Files the API may give no patch for that can't hide a check-weakening line: binaries, and data or prose (eval results).
const UNSCANNED_OK = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|pdf|zip|gz|mp4|webm|mov|wasm|json|jsonl|ndjson|csv|txt|md|svg)$/i

/** One file's items: { lane4: [reason], lane3: bool, ledger: [reason], tests: { removed, added } }. */
function scanFile(f) {
  const lane4 = []
  const ledger = []
  const paths = [f.filename, f.previous_filename].filter(Boolean)
  for (const path of paths) {
    for (const [re, reason] of LANE4_PATHS) if (re.test(path)) { lane4.push(reason); break }
  }
  // Existing check scripts: a change, a deletion, or a move away. New files in a scripts folder (outside sandbox/) aren't.
  if ((SCRIPTS.test(f.filename) && !isNew(f, SCRIPTS)) || (f.previous_filename && SCRIPTS.test(f.previous_filename))) {
    lane4.push('the referee: an existing check script')
  }
  // A deleted test, or a test renamed into a name that isn't one.
  if ((f.status === 'removed' && isTestFile(f.filename)) || (f.status === 'renamed' && isTestFile(f.previous_filename ?? '') && !isTestFile(f.filename))) {
    lane4.push('check-weakening: deletes a test file')
  }
  if (PACKAGE_JSON.test(f.filename) && !f.filename.includes('node_modules/')) lane4.push(...packageChanges(f))
  // Migrations are forward-only: a new file is a ledger item, a change to an existing one is Lane 4.
  if (MIGRATIONS.test(f.filename) || (f.previous_filename && MIGRATIONS.test(f.previous_filename))) {
    if (MIGRATIONS.test(f.filename) && isNew(f, MIGRATIONS)) ledger.push('new migration')
    else lane4.push('irreversible: changes or removes an existing migration')
  }
  if (ROUTES.test(f.filename)) ledger.push('route or access-matrix change')
  const productCode = !isTestFile(f.filename) && !inTestingDir(f.filename)
  if (WRITE_OPS.test(f.filename) && productCode) ledger.push(isNew(f, WRITE_OPS) ? 'new write op' : 'write op change')

  const lane3 = paths.some(p => LANE3_PATHS.some(re => re.test(p)))
  const tests = { removed: 0, added: 0 }

  if (typeof f.patch === 'string') {
    const hunks = parsePatch(f.patch)
    const checkFile = isCheckFile(f.filename)
    for (const hunk of hunks) {
      hunk.lines.forEach((l, i) => {
        if (!l.added) return
        const why = skipIn(hunk.lines, i)
        if (why) lane4.push(`check-weakening: adds ${why} (line ${l.line})`)
      })
      if (checkFile) lane4.push(...loosenedIn(hunk))
    }
    if (isTestFile(f.filename)) {
      tests.removed = countDecls(hunks.flatMap(h => h.removed))
      tests.added = countDecls(hunks.flatMap(h => h.added.map(a => a.text)))
    }
    if (MIGRATIONS.test(f.filename)) {
      for (const { line, text } of hunks.flatMap(h => h.added)) {
        if (!/^\s*--/.test(text) && /\b(?:DROP|RENAME|UPDATE|DELETE)\b/i.test(text)) lane4.push(`irreversible: non-additive migration (line ${line})`)
      }
    }
    if (EGRESS_CODE.test(f.filename) && productCode) {
      const hostsIn = lines => new Set(lines.flatMap(text => [...text.matchAll(QUOTED)].map(m => hostOf(m[2])).filter(Boolean)))
      const added = hostsIn(hunks.flatMap(h => h.added.map(a => a.text)))
      const removed = hostsIn(hunks.flatMap(h => h.removed))
      const fresh = [...added].filter(h => !removed.has(h)).sort()
      if (fresh.length) ledger.push(`adds an egress host: ${fresh.join(', ')}`)
      if (hunks.some(h => [...h.added.map(a => a.text), ...h.removed].some(t => HOST_LIST.test(t)))) ledger.push('changes a host list line (allowedHosts, hosts or HOSTS)')
    }
    if (DOCKERFILE.test(f.filename) && hunks.some(h => dockerInstallChange(h.lines, 'added') || dockerInstallChange(h.old, 'removed'))) {
      lane4.push('dependency change: a Dockerfile install line')
    }
  } else if (f.status !== 'removed' && (f.changes ?? 1) > 0 && !UNSCANNED_OK.test(f.filename)) {
    lane4.push('no diff from the API to scan (too large): read it by hand')
  }
  return { lane4: [...new Set(lane4)], lane3, ledger: [...new Set(ledger)], tests }
}

export const NET_LOSS_PATH = '(the PR\'s test files)'

/** Every file's items, as { lane4: [{ path, reason }], lane3: [path], ledger: [{ path, reason }] }. */
export function scan(files) {
  const out = { lane4: [], lane3: [], ledger: [] }
  const tests = { removed: 0, added: 0 }
  for (const f of files) {
    const s = scanFile(f)
    for (const reason of s.lane4) out.lane4.push({ path: f.filename, reason })
    for (const reason of s.ledger) out.ledger.push({ path: f.filename, reason })
    if (s.lane3) out.lane3.push(f.filename)
    tests.removed += s.tests.removed
    tests.added += s.tests.added
  }
  if (tests.removed > tests.added) {
    out.lane4.push({ path: NET_LOSS_PATH, reason: `check-weakening: net loss of tests (${tests.removed} test, it or describe declarations removed, ${tests.added} added)` })
  }
  return out
}

// ---- Comments -------------------------------------------------------------------------------------------------------

/** A comment line without leading list and emphasis marks; null for a quoted line (`>`), which never counts. */
const bare = line => (/^\s*>/.test(line) ? null : line.replace(/^[\s*_`-]+/, ''))
const commentLines = c => (c.body ?? '').split(/\r?\n/).map(bare).filter(l => l !== null)

/** The reviewer "Gate check:" lines: how many trusted comments say "on ledger", and whether any says "off ledger". */
export function gateChecks(comments) {
  let on = 0
  let off = false
  for (const c of comments) {
    if (!TRUSTED_ASSOCIATIONS.has(c.author_association)) continue
    const lines = commentLines(c)
    if (lines.some(l => /^Gate check:\s*off ledger\b/i.test(l))) off = true
    if (lines.some(l => /^Gate check:\s*on ledger\b/i.test(l))) on++
  }
  return { on, off }
}

/**
 * The head Wasim approved: the SHA in the latest trusted PR comment or review line `wasim-approved: <40-hex sha>` made at
 * or after the label was last added. It must be a commit in the PR, and the base branch must not have changed since.
 * - labeledAt: when the label was last added (ISO), or null.
 * - comments: issue comments and reviews, as { body, author_association, at } (`at`: created or submitted, ISO).
 * - commitShas: the PR's commits.
 * - baseChangedAt: when the PR's base branch was changed (ISO list).
 * - commitCount: how many commits the PR has (the API lists 250 at most; past that the SHA can't be checked).
 * Returns { sha }, { needsLine: true } or { problem }.
 */
export function approvedHead({ labeledAt, comments = [], commitShas = [], baseChangedAt = [], commitCount = commitShas.length }) {
  if (commitShas.length < commitCount) {
    return { problem: `the PR has ${commitCount} commits but the API lists only ${commitShas.length}, so the approved SHA can't be checked` }
  }
  if (!labeledAt) return { problem: `no record of when the ${APPROVAL_LABEL} label was added` }
  const at = Date.parse(labeledAt)
  if (baseChangedAt.some(t => Date.parse(t) > at)) return { problem: 'the base branch changed after the label was added' }
  let latest = null
  for (const c of comments) {
    if (!TRUSTED_ASSOCIATIONS.has(c.author_association) || !c.at || Date.parse(c.at) < at) continue
    for (const l of commentLines(c)) {
      const m = /^wasim-approved:\s*([0-9a-f]{40})(?![0-9a-z])/i.exec(l)
      if (m && (!latest || Date.parse(c.at) >= Date.parse(latest.at))) latest = { at: c.at, sha: m[1].toLowerCase() }
    }
  }
  if (!latest) return { needsLine: true }
  if (!commitShas.map(s => s.toLowerCase()).includes(latest.sha)) return { problem: `the approved SHA ${latest.sha.slice(0, 12)} isn't a commit in this PR` }
  return { sha: latest.sha }
}

const item = i => `${i.path}: ${i.reason}`

/**
 * The verdict for one PR.
 * - files: the PR's file list (see the header).
 * - labels: the PR's label names.
 * - comments: issue comments and reviews, as { body, author_association }.
 * - approvedDeltaFiles: when the label is on and a line names the approved head, the files changed since that head ([]
 *   when it is still the head); null otherwise. Only files the PR still changes count: any other file is as it is on
 *   the base (after a merge from main, main's own changes drop out).
 * - approvalNeedsLine: the label is on but no `wasim-approved: <sha>` line names the approved head.
 * - approvalProblem: why the approval can't stand (the base changed, the SHA isn't in the PR, too many commits), or null.
 * - incomplete: why the file list is incomplete (too many files), or null.
 */
export function classify({ files, labels = [], comments = [], approvedDeltaFiles = null, approvalNeedsLine = false, approvalProblem = null, incomplete = null }) {
  const found = scan(files)
  const checks = gateChecks(comments)
  const lane4 = [...found.lane4]
  if (incomplete) lane4.push({ path: '(the PR)', reason: `file list incomplete: ${incomplete}` })
  const ledger = found.ledger
  if (checks.off) for (const l of ledger) lane4.push({ path: l.path, reason: `off the ledger: ${l.reason}` })

  const lane = lane4.length ? 'Lane 4' : found.lane3.length || ledger.length ? 'Lane 3' : 'Lane 1/2'
  const failures = []
  if (ledger.length && !checks.off && checks.on < GATE_CHECKS_NEEDED) {
    failures.push(`needs ${GATE_CHECKS_NEEDED} reviewer lines starting "Gate check: on ledger" (has ${checks.on}) for: ${ledger.map(item).join('; ')}`)
  }

  const labeled = labels.includes(APPROVAL_LABEL)
  let approval
  if (!lane4.length) approval = labeled ? 'not needed (label present)' : 'not needed'
  else if (!labeled) {
    approval = 'missing'
    failures.push(`needs Wasim's OK for the Lane 4 items: after his yes in chat, add the ${APPROVAL_LABEL} label, then a PR comment line \`${APPROVAL_LABEL}: <sha>\` naming the head he approved, quoting his yes`)
  } else if (approvalProblem) {
    approval = 'stale'
    failures.push(`approval is stale: ${approvalProblem}; ask Wasim again and re-add the label`)
  } else if (approvalNeedsLine || approvedDeltaFiles === null) {
    approval = 'no approved head named'
    failures.push(`add the line \`${APPROVAL_LABEL}: <sha>\` naming the approved head (in a PR comment made at or after the label)`)
  } else {
    const prPaths = new Set(files.flatMap(f => [f.filename, f.previous_filename].filter(Boolean)))
    const delta = scan(approvedDeltaFiles.filter(f => prPaths.has(f.filename) || (f.previous_filename && prPaths.has(f.previous_filename))))
    const deltaLane4 = [...delta.lane4, ...(checks.off ? delta.ledger.map(l => ({ path: l.path, reason: `off the ledger: ${l.reason}` })) : [])]
    if (deltaLane4.length) {
      approval = 'stale'
      failures.push(`approval is stale: ${deltaLane4.map(item).join('; ')}; ask Wasim again and re-add the label`)
    } else approval = approvedDeltaFiles.length ? 'approved (carried over: no Lane 4 item since)' : 'approved'
  }
  return { lane, lane4, lane3: found.lane3, ledger, gateChecks: checks, approval, pass: failures.length === 0, failures }
}

/** The verdict as Markdown: for the job summary and the log. */
export function report(result, { pr, head, approvedSha } = {}) {
  const out = []
  out.push(`## gate: ${result.lane}, ${result.pass ? 'pass' : 'fail'}`)
  if (pr) out.push('', `PR #${pr}${head ? ` at \`${head.slice(0, 12)}\`` : ''}, judged by main's rules (app/scripts/gate/lanes.mjs).`)
  if (result.failures.length) {
    out.push('', '### Fails because')
    for (const f of result.failures) out.push(`- ${f}`)
  }
  out.push('', '### Lane 4 items (need Wasim\'s OK)')
  out.push(...(result.lane4.length ? result.lane4.map(i => `- \`${i.path}\`: ${i.reason}`) : ['- none']))
  out.push('', '### Ledger items (need 2 "Gate check: on ledger" lines)')
  out.push(...(result.ledger.length ? result.ledger.map(i => `- \`${i.path}\`: ${i.reason}`) : ['- none']))
  out.push(`- Gate check lines: ${result.gateChecks.on} on ledger${result.gateChecks.off ? ', and an "off ledger" line (ledger items are Lane 4)' : ''}`)
  const lane4Paths = new Set(result.lane4.map(i => i.path))
  const lane3Only = result.lane3.filter(p => !lane4Paths.has(p))
  out.push('', '### Lane 3 paths (not listed above)')
  out.push(...(lane3Only.length ? lane3Only.map(p => `- \`${p}\``) : ['- none']))
  out.push('', `### Approval (the ${APPROVAL_LABEL} label plus a \`${APPROVAL_LABEL}: <sha>\` line)`, `- ${result.approval}`)
  if (approvedSha) out.push(`- approved head: \`${approvedSha.slice(0, 12)}\``)
  return out.join('\n')
}
