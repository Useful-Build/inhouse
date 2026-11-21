// The JS budget for Today's first load (production plan P-2). Run after `npm run build`.
// Reads the built index.html, takes its module script and modulepreload links, follows each chunk's static imports
// (dynamic `import()` calls are the lazy routes and don't count), and gzips what the browser needs before Today shows.
// Fails when the total is over BUDGET_KB (default 240, in KiB gzipped): the split measured 226 KB on 2026-11-19
// (247 KB before the split), so the budget leaves about 6% of room.
// The budget covers Today's first load only: a deep link to a lazy route adds that route's chunk on top. Raise it only on purpose, with the reason.
// DIST overrides the build folder (for trying the script on a fake build).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = fileURLToPath(new URL('..', import.meta.url))
const budgetKb = Number(process.env.BUDGET_KB ?? 240)
if (!Number.isFinite(budgetKb) || budgetKb <= 0) {
  console.error(`check-bundle: BUDGET_KB must be a positive number, got "${process.env.BUDGET_KB}".`)
  process.exit(1)
}

// The Cloudflare Vite plugin writes the client build to dist/client; a plain Vite build writes dist.
const dist = process.env.DIST ? resolve(process.env.DIST) : join(root, 'dist')
const clientDir = [join(dist, 'client'), dist].find(d => existsSync(join(d, 'index.html')))
if (!clientDir) {
  console.error(`check-bundle: no client/index.html or index.html in ${dist}. Run \`npm run build\` first.`)
  process.exit(1)
}

const html = readFileSync(join(clientDir, 'index.html'), 'utf8')
const fromHtml = [
  ...html.matchAll(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/g),
  ...html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"/g),
].map(m => m[1])
if (!fromHtml.length) {
  console.error('check-bundle: index.html names no module script. The build output changed shape.')
  process.exit(1)
}

// `import x from "./a.js"`, `import{a as b}from"./a.js"`, `import"./a.js"`, `export*from"./a.js"`. Not `import("./a.js")`.
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[\w*${},\s]*?\s*from\s*)?["']([^"']+\.js)["']/g

const seen = new Map() // absolute path -> gzip bytes
const queue = fromHtml.map(href => resolve(clientDir, href.replace(/^\//, '')))
while (queue.length) {
  const file = queue.pop()
  if (seen.has(file)) continue
  if (!existsSync(file)) {
    console.error(`check-bundle: ${file} is imported but missing from the build.`)
    process.exit(1)
  }
  const code = readFileSync(file)
  seen.set(file, gzipSync(code, { level: 9 }).length)
  for (const m of code.toString('utf8').matchAll(STATIC_IMPORT)) {
    queue.push(m[1].startsWith('.') ? resolve(dirname(file), m[1]) : resolve(clientDir, m[1].replace(/^\//, '')))
  }
}

const kb = n => (n / 1024).toFixed(1)
let total = 0
for (const [file, bytes] of [...seen].sort((a, b) => b[1] - a[1])) {
  total += bytes
  console.log(`${kb(bytes).padStart(8)} KB gzip  ${file.slice(clientDir.length + 1)}`)
}
console.log(`${kb(total).padStart(8)} KB gzip  total initial JS for Today (budget ${budgetKb} KB)`)
if (total > budgetKb * 1024) {
  console.error(`check-bundle: ${kb(total)} KB is over the ${budgetKb} KB budget.`)
  process.exit(1)
}
