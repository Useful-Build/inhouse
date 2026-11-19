// One formatting place (P1, C1). Run in app/: node scripts/check-format.mjs
// Fails when code in src/ or shared/ outside src/lib/format.ts calls a locale formatter: `toLocale*` (toLocaleString,
// toLocaleDateString, toLocaleTimeString and the rest), `Intl.DateTimeFormat` or `Intl.NumberFormat`. Times and amounts
// are shown through format.ts, which takes the zone and locale from one selector (src/state/display.ts); a call
// anywhere else would show the device's zone or locale instead. Comments don't count. `npm run lint:tokens` runs it.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['src', 'shared']
const ALLOWED = path.join(root, 'src/lib/format.ts')
const BANNED = [
  [/\.toLocale[A-Za-z]*\s*\(/, 'toLocale*'],
  [/\bIntl\s*\.\s*DateTimeFormat\b/, 'Intl.DateTimeFormat'],
  [/\bIntl\s*\.\s*NumberFormat\b/, 'Intl.NumberFormat'],
]

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

/** The source with comments blanked out (line breaks kept, so line numbers hold). A `//` after a colon or quote is a URL or a string, not a comment. */
const withoutComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, (m, pre) => pre + ' '.repeat(m.length - pre.length))

const problems = []
for (const dir of DIRS) {
  for (const file of walk(path.join(root, dir))) {
    if (file === ALLOWED) continue
    withoutComments(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      for (const [re, name] of BANNED) {
        if (re.test(line)) problems.push(`${path.relative(root, file)}:${i + 1}: ${name} outside src/lib/format.ts. Format through src/lib/format.ts with display().`)
      }
    })
  }
}

if (problems.length) {
  console.error(problems.join('\n'))
  console.error(`check-format: ${problems.length} locale formatting call${problems.length === 1 ? '' : 's'} outside src/lib/format.ts.`)
  process.exit(1)
}
console.log('check-format: no locale formatting outside src/lib/format.ts.')
