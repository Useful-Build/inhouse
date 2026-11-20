// One formatting place (P1, C1). Run in app/: node scripts/check-format.mjs
// Fails when code in src/ or shared/ outside src/lib/format.ts reaches a locale formatter or builds a time by hand:
// - `Intl` in any form (`Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, `const { NumberFormat } = Intl`,
//   `globalThis['Intl']`);
// - `toLocale*` in any access form (`d.toLocaleString()`, `d['toLocaleString']()`, `const { toLocaleString } = d`);
// - `getHours`, `getMinutes`, `getDate`, `getDay`, `getMonth`, `getFullYear` (the device's zone), except in the demo
//   clock (src/agent/clock.ts and demo-clock.ts), which counts in the device's local time until P2 moves it onto the brand's zone.
// Times and amounts are shown through format.ts, which takes the zone and locale from one selector
// (src/state/display.ts); a call anywhere else would show the device's zone or locale instead. The file is parsed (the
// oxc parser rolldown ships), so comments, strings, line breaks and bracket access don't hide a call. Type positions
// (`Intl.DateTimeFormatOptions` in an annotation) don't count. `npm run lint:tokens` runs it; src/lib/format.check.test.ts
// runs a probe file per way around it (scripts/check-format-probes/).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseAst } from 'rolldown/parseAst'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = ['src', 'shared']
/** Paths relative to app/, with forward slashes. */
const FORMAT = 'src/lib/format.ts'
const DEMO_CLOCK = new Set(['src/agent/clock.ts', 'src/agent/demo-clock.ts'])
const LOCAL_GETTERS = new Set(['getHours', 'getMinutes', 'getDate', 'getDay', 'getMonth', 'getFullYear'])

/** TypeScript-only nodes: a name in a type says nothing about what runs. Expression wrappers (`as`, `!`, `satisfies`) are walked. */
const TYPE_ONLY = new Set([
  'TSTypeAnnotation', 'TSTypeReference', 'TSQualifiedName', 'TSTypeQuery', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration',
  'TSTypeParameterDeclaration', 'TSTypeParameterInstantiation', 'TSDeclareFunction', 'TSImportType',
])
const SKIP_KEYS = new Set(['typeAnnotation', 'returnType', 'typeArguments', 'typeParameters', 'superTypeArguments'])

/** What a name reaches, or null when it's allowed in `rel`. */
const bannedName = (name, rel) => {
  if (name === 'Intl') return 'Intl'
  if (/^toLocale[A-Za-z]*$/.test(name)) return name
  if (LOCAL_GETTERS.has(name) && !DEMO_CLOCK.has(rel)) return name
  return null
}

/** Every banned use in one file's source: `{ line, name }`. `rel` is the path relative to app/ (format.ts and the demo clock have allowances). */
export function check(rel, source) {
  if (rel === FORMAT) return []
  const lang = /\.(tsx|jsx)$/.test(rel) ? 'tsx' : /\.ts$/.test(rel) ? 'ts' : 'js'
  const program = parseAst(source, { lang, sourceType: 'module' }, rel)
  const lineOf = (offset) => source.slice(0, offset).split('\n').length
  const found = []
  const hit = (node, text) => {
    const name = typeof text === 'string' ? bannedName(text, rel) : null
    if (name) found.push({ line: lineOf(node.start), name })
  }
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
    if (TYPE_ONLY.has(node.type) || (node.type === 'ImportDeclaration' && node.importKind === 'type')) return
    if (node.type === 'Identifier') hit(node, node.name)
    else if (node.type === 'Literal') hit(node, node.value)
    else if (node.type === 'TemplateLiteral' && node.expressions.length === 0) hit(node, node.quasis[0]?.value.cooked)
    for (const [k, v] of Object.entries(node)) if (!SKIP_KEYS.has(k) && v && typeof v === 'object') walk(v)
  }
  walk(program)
  return found
}

function walkDir(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walkDir(p, out)
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = []
  for (const dir of DIRS) {
    for (const file of walkDir(path.join(root, dir))) {
      const rel = path.relative(root, file).split(path.sep).join('/')
      for (const { line, name } of check(rel, fs.readFileSync(file, 'utf8'))) {
        problems.push(`${rel}:${line}: ${name} outside ${FORMAT}. Format, or read the calendar (calendarOf), through ${FORMAT} with display().`)
      }
    }
  }
  if (problems.length) {
    console.error(problems.join('\n'))
    console.error(`check-format: ${problems.length} locale formatting or local-time call${problems.length === 1 ? '' : 's'} outside ${FORMAT}.`)
    process.exit(1)
  }
  console.log(`check-format: no locale formatting or local-time calls outside ${FORMAT}.`)
}
