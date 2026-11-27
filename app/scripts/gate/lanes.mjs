// The gate check's rules (Part 3 and Part 4 Q2 of the test and merge policy). Pure: no I/O. run.mjs reads the PR
// through the GitHub API and hands it here; .github/workflows/gate.yml runs run.mjs from main, never from the PR.
//
// The lanes: 1 Low and 2 Normal can't be told apart by path, so they are reported together as "Lane 1/2". Lane 3
// (High) is a path list: two AI reviewers, no human. Lane 4 needs Wasim's OK: the referee (CI, test configs, existing
// check scripts, any check-weakening pattern), the rules (AGENTS.md, REVIEW.md, VERIFY.md, docs/decisions), secrets and
// trust boundaries, dependencies, and irreversible jobs. Ledger items (new migrations, route changes, new egress hosts,
// new write ops) pass on two reviewer "Gate check: on ledger" lines, or become Lane 4 on a "Gate check: off ledger" line.
//
// Inputs are GitHub's PR file objects ({ filename, status, previous_filename, patch, changes }); a changed package.json
// also carries `before` and `after` (its text at the merge base and at the head, null when absent).

export const APPROVAL_LABEL = 'wasim-approved'
/** Comment authors whose "Gate check:" lines count (the repo is public: anyone else's are ignored). */
export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])
export const GATE_CHECKS_NEEDED = 2

const isTestFile = path => /\.(test|spec)\.[^/]+$/.test(path)

/** Lane 4 by path alone (any status). Order matters only for the reason shown. */
const LANE4_PATHS = [
  [/^\.github\//, 'the referee: CI workflows and repo settings'],
  [/^app\/(?:hub\/|runner\/)?(?:playwright|vitest)\.config\.[cm]?[jt]s$/, 'the referee: a test config'],
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
const WRITE_OPS = /^app\/hub\/connectors\/[^/]+\/write\//
const ROUTES = /^app\/server\/(?:routes|access-matrix)\.ts$/
const EGRESS = /^app\/server\/egress\//
const SCRIPTS = /^app\/scripts\//
const PACKAGE_JSON = /(?:^|\/)package\.json$/

/** Statuses that make a new file at `filename` (a rename counts only when it moves in from elsewhere). */
const isNew = (f, dir) => f.status === 'added' || f.status === 'copied' || (f.status === 'renamed' && !dir.test(f.previous_filename ?? ''))

const SKIP_PATTERNS = [
  [/\.(?:skip|fixme)\s*\(/, 'a .skip( or .fixme('],
  [/\b(?:test\.describe|describe|it|test)\.(?:skip|fixme)\b/, 'a skipped test or suite'],
  [/\.skipIf\s*\(/, 'a .skipIf('],
  [/\b(?:oxlint|eslint)-disable/, 'a lint disable comment'],
]

/** Numeric settings whose rise (fall for numRuns) weakens a check, by the key's lower-case suffix. */
const LOOSEN_KEYS = ['maxdiffpixelratio', 'maxdiffpixels', 'threshold', 'retries', 'timeout', 'numruns']
const NUMBER_SETTING = /([A-Za-z_$][\w$]*)\s*[:=]\s*(\d[\d_]*(?:\.\d+)?(?:e\d+)?)(?![\w.])/g
const settingKind = key => LOOSEN_KEYS.find(k => key.toLowerCase().endsWith(k)) ?? null

const NON_ADDITIVE_SQL = /\b(?:DROP\s+(?:TABLE|COLUMN)|RENAME\s+(?:TO|COLUMN)|DELETE\s+FROM)\b/i

// A host is a quoted string with a URL scheme, or a dotted name ending in a common top-level domain (dotted event names
// like 'egress.denied' and file names like './x.ts' are not hosts).
const TLDS = new Set(('com net org io dev app co ai cloud shop store me info biz xyz tech so sh gg ly to tv fm us uk ca au de fr nl eu jp in ' +
  'es it se ch no dk fi pl br mx nz ie be at pt site online page link run host email').split(' '))
const QUOTED = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g
const HOST = /^(?:(?:https?|wss?):\/\/)?(?:\*\.|\.)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z][a-z0-9-]{0,62}))(?::\d+)?(?:[/?#].*)?$/i

function hostOf(s) {
  const m = HOST.exec(s)
  if (!m) return null
  if (!/^(?:https?|wss?):\/\//i.test(s) && !TLDS.has(m[2].toLowerCase())) return null
  return m[1].toLowerCase()
}

/** A unified-diff patch (GitHub's `patch`: hunks only) as hunks of { added: [{ line, text }], removed: [text] }. */
export function parsePatch(patch) {
  const hunks = []
  let hunk = null
  let next = 0
  for (const raw of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (h) { hunk = { added: [], removed: [] }; hunks.push(hunk); next = Number(h[1]); continue }
    if (!hunk) continue
    if (raw.startsWith('+')) hunk.added.push({ line: next++, text: raw.slice(1) })
    else if (raw.startsWith('-')) hunk.removed.push(raw.slice(1))
    else if (!raw.startsWith('\\')) next++
  }
  return hunks
}

/** Each numeric setting on a line, in order: [{ key, kind, value }]. */
function settings(text) {
  const out = []
  for (const m of text.matchAll(NUMBER_SETTING)) {
    const kind = settingKind(m[1])
    if (kind) out.push({ key: m[1], kind, value: Number(m[2].replaceAll('_', '')) })
  }
  return out
}

/** The check-weakening items in one hunk: skip and lint-disable patterns, and loosened numeric settings. */
function weakeningIn(hunk) {
  const found = []
  for (const { line, text } of hunk.added) {
    const hit = SKIP_PATTERNS.find(([re]) => re.test(text))
    if (hit) found.push(`check-weakening: adds ${hit[1]} (line ${line})`)
  }
  // Pair each added setting with the removed one of the same key, in order.
  const removedByKey = new Map()
  for (const text of hunk.removed) {
    for (const s of settings(text)) removedByKey.set(s.key, [...(removedByKey.get(s.key) ?? []), s.value])
  }
  for (const { line, text } of hunk.added) {
    for (const s of settings(text)) {
      const queue = removedByKey.get(s.key)
      // A retries setting with nothing removed was 0 before (never add retries); other new settings aren't loosened.
      const before = queue?.length ? queue.shift() : s.kind === 'retries' ? 0 : null
      if (before === null) continue
      const loosened = s.kind === 'numruns' ? s.value < before : s.value > before
      if (loosened) found.push(`check-weakening: ${s.key} ${s.kind === 'numruns' ? 'lowered' : 'raised'} from ${before} to ${s.value} (line ${line})`)
    }
  }
  return found
}

const DEP_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides']
const sortedJson = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

/** Whether a package.json's dependency blocks differ; null when it can't be read (a Lane 4 item of its own). */
function dependencyChange(f) {
  if (f.before === undefined || f.after === undefined) throw new Error(`${f.filename}: the package.json text (before and after) wasn't fetched`)
  let before, after
  try {
    before = f.before === null ? {} : JSON.parse(f.before)
    after = f.after === null ? {} : JSON.parse(f.after)
  } catch {
    return null
  }
  return DEP_KEYS.some(k => sortedJson(before?.[k] ?? null) !== sortedJson(after?.[k] ?? null))
}

// Files the API may give no patch for that can't hide a check-weakening line: binaries, and data or prose (eval results).
const UNSCANNED_OK = /\.(?:png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|pdf|zip|gz|mp4|webm|mov|wasm|json|jsonl|ndjson|csv|txt|md|svg)$/i

/** One file's items: { lane4: [reason], lane3: bool, ledger: [reason] }. */
function scanFile(f) {
  const lane4 = []
  const ledger = []
  const paths = [f.filename, f.previous_filename].filter(Boolean)
  for (const path of paths) {
    for (const [re, reason] of LANE4_PATHS) if (re.test(path)) { lane4.push(reason); break }
  }
  // Existing check scripts: a change, a deletion, or a move away. New files under app/scripts/ (outside sandbox/) aren't.
  if ((SCRIPTS.test(f.filename) && !isNew(f, SCRIPTS)) || (f.previous_filename && SCRIPTS.test(f.previous_filename))) {
    lane4.push('the referee: an existing check script')
  }
  // A deleted test, or a test renamed into a name that isn't one.
  if ((f.status === 'removed' && isTestFile(f.filename)) || (f.status === 'renamed' && isTestFile(f.previous_filename ?? '') && !isTestFile(f.filename))) {
    lane4.push('check-weakening: deletes a test file')
  }
  if (PACKAGE_JSON.test(f.filename) && !f.filename.includes('node_modules/')) {
    const changed = dependencyChange(f)
    if (changed === null) lane4.push('dependency change: a package.json that can\'t be read')
    else if (changed) lane4.push('dependency change')
  }
  // Migrations are forward-only: a new file is a ledger item, a change to an existing one or a non-additive statement is Lane 4.
  if (MIGRATIONS.test(f.filename) || (f.previous_filename && MIGRATIONS.test(f.previous_filename))) {
    if (MIGRATIONS.test(f.filename) && isNew(f, MIGRATIONS)) ledger.push('new migration')
    else lane4.push('irreversible: changes or removes an existing migration')
  }
  if (ROUTES.test(f.filename)) ledger.push('route or access-matrix change')
  if (WRITE_OPS.test(f.filename) && isNew(f, WRITE_OPS)) ledger.push('new write op')

  const lane3 = paths.some(p => LANE3_PATHS.some(re => re.test(p)))

  if (typeof f.patch === 'string') {
    const hunks = parsePatch(f.patch)
    for (const hunk of hunks) lane4.push(...weakeningIn(hunk))
    if (MIGRATIONS.test(f.filename) && /\.sql$/i.test(f.filename)) {
      for (const hunk of hunks) {
        for (const { line, text } of hunk.added) {
          if (!/^\s*--/.test(text) && NON_ADDITIVE_SQL.test(text)) lane4.push(`irreversible: a non-additive migration statement (line ${line})`)
        }
      }
    }
    if (EGRESS.test(f.filename) && !isTestFile(f.filename)) {
      const hostsIn = lines => new Set(lines.flatMap(text => [...text.matchAll(QUOTED)].map(m => hostOf(m[2])).filter(Boolean)))
      const added = hostsIn(hunks.flatMap(h => h.added.map(a => a.text)))
      const removed = hostsIn(hunks.flatMap(h => h.removed))
      const fresh = [...added].filter(h => !removed.has(h)).sort()
      if (fresh.length) ledger.push(`adds an egress host: ${fresh.join(', ')}`)
    }
  } else if (f.status !== 'removed' && (f.changes ?? 1) > 0 && !UNSCANNED_OK.test(f.filename)) {
    lane4.push('no diff from the API to scan (too large): read it by hand')
  }
  return { lane4: [...new Set(lane4)], lane3, ledger }
}

/** Every file's items, as { lane4: [{ path, reason }], lane3: [path], ledger: [{ path, reason }] }. */
export function scan(files) {
  const out = { lane4: [], lane3: [], ledger: [] }
  for (const f of files) {
    const s = scanFile(f)
    for (const reason of s.lane4) out.lane4.push({ path: f.filename, reason })
    for (const reason of s.ledger) out.ledger.push({ path: f.filename, reason })
    if (s.lane3) out.lane3.push(f.filename)
  }
  return out
}

/** A comment line's text without leading quote, list and emphasis marks. */
const bare = line => line.replace(/^[\s>*_`-]+/, '')

/** The reviewer "Gate check:" lines: how many trusted comments say "on ledger", and whether any says "off ledger". */
export function gateChecks(comments) {
  let on = 0
  let off = false
  for (const c of comments) {
    if (!TRUSTED_ASSOCIATIONS.has(c.author_association)) continue
    const lines = (c.body ?? '').split(/\r?\n/).map(bare)
    if (lines.some(l => /^Gate check:\s*off ledger\b/i.test(l))) off = true
    if (lines.some(l => /^Gate check:\s*on ledger\b/i.test(l))) on++
  }
  return { on, off }
}

const item = i => `${i.path}: ${i.reason}`

/**
 * The verdict for one PR.
 * - files: the PR's file list (see the header).
 * - labels: the PR's label names.
 * - comments: issue comments and reviews, as { body, author_association }.
 * - approvedDeltaFiles: when the approval label is on, the files changed since the head it was added on ([] when that is
 *   still the head); null when no approval record could be read (then approvalProblem says why). Only files the PR still
 *   changes count: any other file is as it is on the base (after a merge from main, main's own changes drop out).
 * - approvalProblem: why the approval can't carry over (a force-push since, or no head found), or null.
 * - incomplete: why the file list is incomplete (too many files), or null.
 */
export function classify({ files, labels = [], comments = [], approvedDeltaFiles = null, approvalProblem = null, incomplete = null }) {
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
    failures.push(`needs Wasim's OK for the Lane 4 items: after his yes in chat, add the ${APPROVAL_LABEL} label and quote his yes in the PR`)
  } else if (approvalProblem || approvedDeltaFiles === null) {
    approval = 'stale'
    failures.push(`approval is stale: ${approvalProblem ?? 'no record of the approved head'}; ask Wasim again and re-add the label`)
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

/**
 * The head a PR had when the approval label was last added, from its timeline and each commit's push time.
 * - labeledAt: when the label was last added (ISO), or null.
 * - forcePushedAt: when the head branch was force-pushed (ISO list).
 * - commits: the PR's commits, oldest first, as { sha, pushedAt } (pushedAt: the first check suite on the PR's head
 *   branch, or null when none was made for it, as for the inner commits of a push).
 * Returns { sha } or { problem }.
 */
export function approvedHead({ labeledAt, forcePushedAt = [], commits }) {
  if (!labeledAt) return { problem: `no record of when the ${APPROVAL_LABEL} label was added` }
  const at = Date.parse(labeledAt)
  if (forcePushedAt.some(t => Date.parse(t) > at)) return { problem: 'the branch was force-pushed after the label was added' }
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]
    if (c.pushedAt && Date.parse(c.pushedAt) <= at) return { sha: c.sha }
  }
  return { problem: 'no commit of this PR was pushed before the label was added' }
}

/** The verdict as Markdown: for the job summary and the log. */
export function report(result, { pr, head } = {}) {
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
  out.push('', `### Approval (${APPROVAL_LABEL})`, `- ${result.approval}`)
  return out.join('\n')
}
