// Inhouse's own token rules, on top of ui-base's scripts/check-tokens.mjs (which checks colors and token overrides).
// App-owned: ui-base's update leaves this file alone. It fails on:
//   1. Tailwind arbitrary values (`w-[330px]`, `bg-x/[4.5%]`, `[overflow-wrap:anywhere]`) in .ts and .tsx, except in
//      the base-owned shadcn components (src/components/ui/). Variants (`data-[state=open]:`, `[&_svg]:`, `has-[...]:`)
//      are fine;
//   2. inline `style` props in .tsx that carry a literal (a number, a quoted string, a var(--...)), also as a fallback
//      (`?? 20`, `|| 20`, `&& 20`) or a ternary branch. Values computed at runtime (a bar's height from data, a
//      position from state) are fine.
//   3. fixed waits in the E2E specs (e2e/**/*.ts): `waitForTimeout(` and a promise wrapped around `setTimeout`
//      (`new Promise(r => setTimeout(r, 500))`). Wait for a condition (an `expect` or `expect.poll`), or move time with
//      the Clock API (`page.clock.install()`, `page.clock.runFor(ms)`). `test.setTimeout(` and `page.clock.*` are fine.
// Exceptions live in scripts/check-app-rules.allow.json, each with a reason. An entry nothing uses fails too.
// Run: npm run lint:tokens (part of npm run lint).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Optional argument: the src/ folder to check (default: this app's src/).
const root = process.argv[2] ? process.argv[2].replace(/\/?$/, '/') : new URL('../src/', import.meta.url).pathname
const allow = JSON.parse(readFileSync(new URL('./check-app-rules.allow.json', import.meta.url), 'utf8'))
const problems = []
for (const e of [...allow.files, ...allow.classes]) if (!e.reason?.trim()) problems.push(`check-app-rules.allow.json: ${e.path ?? e.class} has no reason`)
// Content art (a picture rather than UI): skipped by both rules. Counts the hits each entry stands in for.
const ALLOWED = new Map(allow.files.map(e => [e.path, 0]))
// Exact arbitrary class strings that can't be a token or a scale step.
const ALLOWED_CLASSES = new Map(allow.classes.map(e => [e.class, 0]))
// Base-owned shadcn components: kept close to upstream, so their arbitrary values stay.
const BASE = 'components/ui/'

const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : [])

// ---------- arbitrary values ----------
// Each [...] group in a line (nested brackets kept together) is a variant when a `:` follows it (`data-[x]:`,
// `[&_svg]:`, `group-data-[x]/name:`), an arbitrary value after `-` or `/` (`w-[3px]`, `bg-x/[4.5%]`), and an
// arbitrary property when it holds `prop:value` with no spaces (`[overflow-wrap:anywhere]`).
const CLASS_EDGE = /[\s'"`{}()]/
const arbitrary = line => {
  const found = []
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '[') continue
    let d = 0, j = i
    for (; j < line.length; j++) { if (line[j] === '[') d++; else if (line[j] === ']' && --d === 0) break }
    if (j >= line.length) break
    const inner = line.slice(i + 1, j), before = line[i - 1] ?? ' ', after = line.slice(j + 1)
    const isVariant = /^(?:\/[\w-]+)?:/.test(after)
    const isValue = (before === '-' || before === '/') && /[a-z0-9]/i.test(line[i - 2] ?? '')
    const isProperty = (CLASS_EDGE.test(before) || before === ':') && /^-{0,2}[a-z][a-z-]*:[^\s]+$/.test(inner)
    if (!isVariant && (isValue || isProperty)) {
      let a = i, b = j + 1
      while (a > 0 && !CLASS_EDGE.test(line[a - 1])) a--
      while (b < line.length && !CLASS_EDGE.test(line[b])) b++
      found.push(line.slice(a, b))
    }
    i = j
  }
  return found
}

// ---------- inline styles ----------
// Splits `src` at top-level occurrences of the characters in `seps`, skipping strings, templates and brackets.
const splitTop = (src, seps) => {
  const parts = []; let depth = 0, quote = null, start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && seps.includes(c)) { parts.push([src.slice(start, i), start]); start = i + 1 }
  }
  parts.push([src.slice(start), start])
  return parts
}
const LITERAL = /^(?:-?\d[\d.]*|'[^']*'|"[^"]*"|`[^`$]*`)$/
// Splits `src` at top-level `op` (a `?` that is not `??` or `?.`).
const splitOp = (src, op) => {
  const parts = []; let depth = 0, quote = null, start = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') quote = c
    else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) depth--
    else if (depth === 0 && src.startsWith(op, i) && !(op === '?' && (src[i + 1] === '?' || src[i + 1] === '.' || src[i - 1] === '?'))) {
      parts.push(src.slice(start, i)); start = i + op.length; i += op.length - 1
    }
  }
  parts.push(src.slice(start))
  return parts
}
// A style value carries a literal when it is one, holds a var(--...), or picks between branches (ternaries, nested too)
// or falls back (`??`, `||`, `&&`) to one.
const carriesLiteral = value => {
  let v = value.trim()
  if (LITERAL.test(v) || v.includes('var(--')) return true
  // A value wrapped in one pair of parentheses: look inside.
  if (v.startsWith('(') && v.endsWith(')') && splitOp(v, '?').length === 1 && !splitOp(v, '||')[1] && !splitOp(v, '??')[1]) {
    let d = 0
    for (let i = 0; i < v.length; i++) { if (v[i] === '(') d++; else if (v[i] === ')' && --d === 0 && i < v.length - 1) { d = -1; break } }
    if (d === 0) return carriesLiteral(v.slice(1, -1))
  }
  const q = splitOp(v, '?')
  if (q.length > 1) return splitOp(q.slice(1).join('?'), ':').some(carriesLiteral)
  for (const op of ['||', '??', '&&']) {
    const parts = splitOp(v, op)
    if (parts.length > 1) return parts.slice(1).some(carriesLiteral)
  }
  return false
}
const inlineStyles = text => {
  const found = []
  for (const m of text.matchAll(/\bstyle(?:=\{\{|:\s*\{)/g)) {
    const open = m.index + m[0].length - 1
    let d = 0, k = open
    for (; k < text.length; k++) { if (text[k] === '{') d++; else if (text[k] === '}' && --d === 0) break }
    const body = text.slice(open + 1, k)
    for (const [prop, at] of splitTop(body, ',')) {
      const p = prop.trim()
      if (!p || p.startsWith('...')) continue
      const colon = splitTop(p, ':')
      if (colon.length < 2) continue
      if (carriesLiteral(colon.slice(1).map(c => c[0]).join(':'))) {
        const index = open + 1 + at + prop.indexOf(p)
        found.push([text.slice(0, index).split('\n').length, p])
      }
    }
  }
  return found
}

const hits = { arbitrary: [], style: [] }
for (const file of walk(root)) {
  const rel = relative(root, file)
  const text = readFileSync(file, 'utf8')
  const found = { arbitrary: [], style: [] }
  text.split('\n').forEach((line, i) => {
    if (rel.startsWith(BASE) || /^\s*(\/\/|\*|\/\*)/.test(line)) return
    for (const c of arbitrary(line)) {
      // A use inside an allowed file is covered by the file's entry: it doesn't keep a class entry alive.
      if (ALLOWED_CLASSES.has(c)) { if (!ALLOWED.has(rel)) ALLOWED_CLASSES.set(c, ALLOWED_CLASSES.get(c) + 1) }
      else found.arbitrary.push(`src/${rel}:${i + 1}  ${c}`)
    }
  })
  if (rel.endsWith('.tsx')) for (const [ln, p] of inlineStyles(text)) found.style.push(`src/${rel}:${ln}  style ${p.replace(/\s+/g, ' ')}`)
  if (ALLOWED.has(rel)) { ALLOWED.set(rel, found.arbitrary.length + found.style.length); continue }
  hits.arbitrary.push(...found.arbitrary)
  hits.style.push(...found.style)
}
for (const [path, n] of ALLOWED) {
  if (!existsSync(join(root, path))) problems.push(`check-app-rules.allow.json: ${path} doesn't exist; remove it`)
  else if (!n) problems.push(`check-app-rules.allow.json: ${path} breaks neither rule; remove it`)
}
for (const [c, n] of ALLOWED_CLASSES) if (!n) problems.push(`check-app-rules.allow.json: ${c} is not used anywhere; remove it`)

// ---------- fixed waits in e2e ----------
const e2eDir = new URL('../e2e/', import.meta.url).pathname
const waits = []
// Blanks comments (keeping newlines, so line numbers stay right) and leaves strings alone.
const stripComments = src => {
  let out = '', quote = null
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (quote) { out += c; if (c === '\\') out += src[++i] ?? ''; else if (c === quote) quote = null; continue }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c }
    else if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; i--; }
    else if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2), stop = end < 0 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, ' '); i = stop - 1
    } else out += c
  }
  return out
}
const FIXED_WAITS = [
  /\bwaitForTimeout\b/, // page.waitForTimeout(...) and page['waitForTimeout'](...)
  /new\s+Promise\b[^;]{0,200}?\bsetTimeout\b/s, // new Promise(r => setTimeout(r, ms)), also across lines
  /import\s*\{[^}]*\bsetTimeout\b[^}]*\}\s*from\s*['"](?:node:)?timers\/promises['"]/s, // aliased or not
  /\bscheduler\s*\.\s*wait\s*\(/,
]
if (existsSync(e2eDir)) for (const file of walk(e2eDir)) {
  const text = readFileSync(file, 'utf8'), code = stripComments(text), lines = text.split('\n')
  const seen = new Set()
  for (const re of FIXED_WAITS) for (const m of code.matchAll(new RegExp(re.source, re.flags + 'g'))) {
    const ln = code.slice(0, m.index).split('\n').length
    if (seen.has(ln)) continue
    seen.add(ln)
    waits.push([ln, `e2e/${relative(e2eDir, file)}:${ln}  ${lines[ln - 1].trim()}`])
  }
}
waits.sort((x, y) => x[1].localeCompare(y[1]) || x[0] - y[0])
for (let i = 0; i < waits.length; i++) waits[i] = waits[i][1]

const report = (list, msg) => { if (list.length) console.error(`${list.length} ${msg}\n${list.join('\n')}\n`) }
report(hits.arbitrary, 'arbitrary value(s). Use a scale step (w-82.5 = 330px) or an --app-* token in src/index.css:')
report(hits.style, 'inline style(s) with a literal. Use a class, or compute the value from data:')
report(waits, 'fixed wait(s) in e2e. Wait for a condition (expect, expect.poll) or use the Clock API (page.clock.install(), page.clock.runFor(ms)):')
report(problems, 'allow-list problem(s):')
if (hits.arbitrary.length + hits.style.length + waits.length + problems.length) process.exit(1)
console.log('app rules: no arbitrary values (outside src/components/ui), literal inline styles or fixed waits in e2e')
