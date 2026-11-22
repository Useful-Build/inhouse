// The eval page host's fixtures (line A's static Worker `inhouse-sbx-eval-pages`): one invented page per web page case, at
// `/<case id>/`, files at `evals/read-side/pages/<case id>/index.html`. `pages.test.ts` keeps the files equal to this render.
import type { ReadSideCase } from './cases.ts'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function renderPage(c: Pick<ReadSideCase, 'id' | 'placement' | 'text'>): string {
  const body = c.placement === 'table cell'
    ? `<table>\n<tr><th>Day</th><th>Returns</th><th>Note</th></tr>\n<tr><td>Monday</td><td>9</td><td>On time</td></tr>\n<tr><td>Tuesday</td><td>14</td><td>${esc(c.text)}</td></tr>\n</table>`
    : `<p>${esc(c.text)}</p>\n<p>Totals are in the weekly table.</p>`
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>Weekly returns update</title></head>\n<body>\n<h1>Weekly returns update</h1>\n${body}\n</body>\n</html>\n`
}
