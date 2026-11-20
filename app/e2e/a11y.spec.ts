// Accessibility: axe (WCAG 2.1 A and AA) on the main pages and pop-ups in states.ts, light and dark, at desktop size.
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from './csp.js'
import type { Page } from '@playwright/test'
import type { Result } from 'axe-core'
import { openState, STATES, THEMES } from './states.js'

// Known issues that need a design call or a structural change. Each one skips a single rule on nodes inside
// its selector (el.closest(selector)), in every state or only in the states it names; the rule still runs everywhere else.
const EXCLUDED: { rule: string; selector: string; why: string; states?: string[] }[] = [
  // An open Radix Select (Settings dropdowns) sets aria-hidden on the rest of the page (the sidebar and main, around
  // the toast's live region) and traps focus in its list, so the hidden controls can't be reached, but axe still
  // counts them as focusable. Radix behaviour, not ours. Scoped to the state with an open list, so any other state
  // that hides focusable content still fails.
  { rule: 'aria-hidden-focus', selector: '[data-aria-hidden]', why: 'Radix hides the page while a select list is open', states: ['pop-settings-dropdown'] },
]

async function remaining(page: Page, state: string, v: Result) {
  const rules = EXCLUDED.filter(x => x.rule === v.id && (!x.states || x.states.includes(state)))
  if (!rules.length) return v.nodes
  const keep = await Promise.all(v.nodes.map(n => page.evaluate(([target, selectors]) => {
    const el = document.querySelector(target)
    return !el || !selectors.some(sel => el.closest(sel))
  }, [String(n.target[0]), rules.map(x => x.selector)] as const)))
  return v.nodes.filter((_, i) => keep[i])
}

for (const theme of THEMES) {
  for (const s of STATES.filter(x => x.a11y)) {
    test(`${theme} · ${s.name}`, async ({ page }) => {
      await openState(page, s, theme)
      // Radix pop-ups fade and zoom in; axe reads colors mid-animation as low contrast, so wait for finite animations to end.
      await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity))
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze()
      const found = (await Promise.all(violations.map(async v => ({ ...v, nodes: await remaining(page, s.name, v) })))).filter(v => v.nodes.length)
      const report = found.map(v => `${v.id} (${v.impact}): ${v.help}\n` +
        v.nodes.map(n => `  ${n.target.join(' ')}  ${n.failureSummary?.split('\n').slice(1, 2).join('')}\n    ${n.html.slice(0, 400)}`).join('\n'))
      expect(found, report.join('\n')).toEqual([])
    })
  }
}
