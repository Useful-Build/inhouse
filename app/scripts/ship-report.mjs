// Reads the ship run's Playwright JSON report. Used by the `ship` workflow.
//   node scripts/ship-report.mjs check <report.json> <results-dir>   fails on zero tests or a test without a video file
//   node scripts/ship-report.mjs list <report.json>                  one line per test, in report order: project, title, video path under results/
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, reportPath, resultsDir] = process.argv.slice(2)
if (!['check', 'list'].includes(mode) || !reportPath || (mode === 'check' && !resultsDir)) {
  console.error('usage: ship-report.mjs check <report.json> <results-dir> | list <report.json>')
  process.exit(2)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const tests = []
const walk = suite => {
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const last = t.results?.at(-1)
      const video = last?.attachments?.find(a => a.name === 'video' && a.path)?.path
      tests.push({ project: t.projectName, title: spec.title, video: video?.replace(/^.*[\\/]results[\\/]/, '') })
      // A spec that signs a second person in (their own browser context) attaches their video as `video-<who>`, in the order
      // they were made. Each follows the test's own clip in the reel, its card naming the person.
      for (const x of last?.attachments?.filter(x => /^video-./.test(x.name) && x.path) ?? []) {
        tests.push({ project: t.projectName, title: `${spec.title} (${x.name.slice('video-'.length)})`, video: x.path.replace(/^.*[\\/]results[\\/]/, '') })
      }
    }
  }
  for (const s of suite.suites ?? []) walk(s)
}
for (const s of report.suites ?? []) walk(s)

if (mode === 'list') {
  for (const t of tests) {
    if (t.video && (/^([\\/]|[A-Za-z]:)/.test(t.video) || t.video.split(/[\\/]/).includes('..'))) {
      console.error(`unsafe video path: [${t.project}] ${t.title}`)
      process.exit(1)
    }
  }
  // Tabs and newlines in a title would forge extra fields or lines in this tab-separated list.
  for (const t of tests) console.log([t.project, t.title.replace(/[\t\r\n]+/g, ' '), t.video].join('\t'))
} else {
  const problems = []
  if (tests.length === 0) problems.push('no tests ran')
  for (const t of tests) {
    if (!t.video) problems.push(`no video recorded: [${t.project}] ${t.title}`)
    else if (!existsSync(join(resultsDir, t.video))) problems.push(`video file missing: [${t.project}] ${t.title}`)
  }
  console.log(`${tests.length} tests`)
  if (problems.length) {
    for (const p of problems) console.error(`::error::${p}`)
    process.exit(1)
  }
}
