// The gate check's CLI: reads one PR through the GitHub API (`gh api`, read-only) and judges it with lanes.mjs.
//   node app/scripts/gate/run.mjs --repo <owner/name> --pr <number>
// .github/workflows/gate.yml runs it from main with GH_TOKEN set to the workflow's read-only token; locally it uses your
// own `gh` sign-in (a dry run: it only reads). It never checks out or runs the PR's code: the file list, patches,
// package.json texts, labels, comments, reviews and timeline all come from the API.
// Prints the verdict (and appends it to $GITHUB_STEP_SUMMARY when set). Exit 0: pass. 1: needs Wasim's OK, a reviewer
// "Gate check:" line, or a fresh approval. 2: a crash or a usage error (the workflow fails on it too).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { APPROVAL_LABEL, approvedHead, classify, report } from './lanes.mjs'

/** GitHub caps a PR's file list at 3000 and a comparison's at 300. */
const COMPARE_FILE_CAP = 300

function usage(message) {
  console.error(`gate: ${message}\nusage: node app/scripts/gate/run.mjs --repo <owner/name> --pr <number>`)
  process.exit(2)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (k !== '--repo' && k !== '--pr') usage(`unknown argument ${JSON.stringify(k)}`)
    if (v === undefined) usage(`${k} needs a value`)
    args[k.slice(2)] = v
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo ?? '')) usage('--repo must be owner/name')
  if (!/^[1-9]\d*$/.test(args.pr ?? '')) usage('--pr must be a PR number')
  return args
}

const ghText = args => execFileSync('gh', ['api', ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
const get = path => JSON.parse(ghText([path]))
/** Every page of a list endpoint, flattened. */
const getAll = path => JSON.parse(ghText(['--paginate', '--slurp', path])).flat()
/** A workflow command's data, escaped as @actions/core does, so a file name can't end the command or start another. */
const escapeData = s => s.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
const encodePath = p => p.split('/').map(encodeURIComponent).join('/')

/** A file's text at a commit, or null when it doesn't exist there. */
function textAt(repo, path, ref) {
  try {
    return ghText(['-H', 'Accept: application/vnd.github.raw+json', `repos/${repo}/contents/${encodePath(path)}?ref=${ref}`])
  } catch (e) {
    if (/HTTP 404/.test(String(e.stderr))) return null
    throw e
  }
}

/** Adds `before` and `after` texts to each package.json in a file list (needed for the dependency rule). */
function withPackageTexts(repo, files, beforeRef, afterRef) {
  return files.map(f => {
    if (!/(?:^|\/)package\.json$/.test(f.filename)) return f
    const before = f.status === 'added' ? null : textAt(repo, f.previous_filename ?? f.filename, beforeRef)
    const after = f.status === 'removed' ? null : textAt(repo, f.filename, afterRef)
    return { ...f, before, after }
  })
}

/** The files changed between two commits (three-dot, as GitHub's compare), with package.json texts; or a problem. */
function filesBetween(repo, from, to) {
  const cmp = get(`repos/${repo}/compare/${from}...${to}`)
  const files = cmp.files ?? []
  if (files.length >= COMPARE_FILE_CAP) return { problem: `${files.length}+ files changed since the approval, too many to check` }
  return { files: withPackageTexts(repo, files, cmp.merge_base_commit.sha, to) }
}

/**
 * The approval record: the head a `wasim-approved: <sha>` line names (made at or after the label was last added), and
 * the files changed since. Fails closed when the PR has more commits than the API lists (250), so the SHA can't be checked.
 */
function approval(repo, pr, prData, comments) {
  const timeline = getAll(`repos/${repo}/issues/${pr}/timeline?per_page=100`)
  const labeledAt = timeline.filter(e => e.event === 'labeled' && e.label?.name === APPROVAL_LABEL).map(e => e.created_at).at(-1) ?? null
  const baseChangedAt = timeline.filter(e => e.event === 'base_ref_changed').map(e => e.created_at)
  const commitShas = getAll(`repos/${repo}/pulls/${pr}/commits?per_page=100`).map(c => c.sha)
  const head = approvedHead({ labeledAt, comments, commitShas, baseChangedAt, commitCount: prData.commits })
  if (head.problem) return { approvalProblem: head.problem }
  if (head.needsLine) return { approvalNeedsLine: true }
  if (head.sha === prData.head.sha) return { approvedDeltaFiles: [], approvedSha: head.sha }
  const delta = filesBetween(repo, head.sha, prData.head.sha)
  if (delta.problem) return { approvalProblem: delta.problem }
  return { approvedDeltaFiles: delta.files, approvedSha: head.sha }
}

function main() {
  const { repo, pr } = parseArgs(process.argv.slice(2))
  const prData = get(`repos/${repo}/pulls/${pr}`)
  const head = prData.head.sha
  const listed = getAll(`repos/${repo}/pulls/${pr}/files?per_page=100`)
  const incomplete = listed.length < prData.changed_files ? `the API listed ${listed.length} of ${prData.changed_files} changed files` : null
  // The PR's diff is against the merge base of its base and head, so package.json's "before" is read there.
  const mergeBase = get(`repos/${repo}/compare/${prData.base.sha}...${head}`).merge_base_commit.sha
  const files = withPackageTexts(repo, listed, mergeBase, head)
  const labels = prData.labels.map(l => l.name)
  const comments = [
    ...getAll(`repos/${repo}/issues/${pr}/comments?per_page=100`),
    ...getAll(`repos/${repo}/pulls/${pr}/reviews?per_page=100`),
  ].map(c => ({ body: c.body ?? '', author_association: c.author_association, at: c.created_at ?? c.submitted_at ?? null }))
  const { approvedSha, ...record } = labels.includes(APPROVAL_LABEL) ? approval(repo, pr, prData, comments) : {}

  const result = classify({ files, labels, comments, incomplete, ...record })
  const text = report(result, { pr, head, approvedSha })
  // The report holds the PR's file names: stop the runner reading workflow commands from it while it prints.
  const resume = randomUUID()
  console.log(`::stop-commands::${resume}`)
  console.log(text)
  console.log(`::${resume}::`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
  for (const f of result.failures) console.log(`::error title=gate::${escapeData(f)}`)
  return result.pass ? 0 : 1
}

try {
  process.exitCode = main()
} catch (e) {
  console.error(`::error title=gate crashed::${escapeData(String(e?.message ?? e).split('\n')[0])}`)
  console.error(e?.stderr ? String(e.stderr) : e)
  process.exitCode = 2
}
