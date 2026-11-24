// Our skills' pages on the product (P6a brand skills, master plan standing decision 6; route 84): the Worker bundle
// carries a copy of each SKILL.md from the runner's plugin, and serves its instructions with the frontmatter dropped.
// `dataviz` ships inside the engine, so its text isn't ours to copy: it gets our own short summary.
// When each last changed is `OUR_SKILL_CHANGES` (list.ts), pinned to the file by its hash.
import { stripFrontmatter } from '../../shared/protocol/brand-skills.ts'
import { OUR_SKILL_CHANGES } from './list.ts'
import pdf from '../../runner/image/plugin/skills/pdf/SKILL.md?raw'
import word from '../../runner/image/plugin/skills/word/SKILL.md?raw'
import spreadsheet from '../../runner/image/plugin/skills/spreadsheet/SKILL.md?raw'
import skillCreator from '../../runner/image/plugin/skills/skill-creator/SKILL.md?raw'

export const DATAVIZ_SUMMARY = `# Charts and tables

Your Inhouse agent uses this skill whenever it turns numbers into something you can read at a glance: a chart, a table, a set of key figures or a small dashboard.

## What it does

- Picks the kind of chart that fits the question, such as a line for a trend over time or bars to compare a few things.
- Keeps colours calm and consistent, and makes sure they read well in light and dark mode.
- Labels what matters (the axes, the units, the latest value) and leaves out decoration.

## Where it comes from

This skill ships with the engine your Inhouse agent runs on. The Inhouse team keeps it on for every brand. Its full instructions belong to the engine, so this page shows a summary.
`

/** Each of our skills' text as it ships. */
const TEXTS: Readonly<Record<string, string>> = { dataviz: DATAVIZ_SUMMARY, pdf, word, spreadsheet, 'skill-creator': skillCreator }

/** One of our skills' instructions (no frontmatter), and when they changed; null for a name that isn't ours. */
export function ourSkillPage(name: string): { body: string; changedAtMs: number } | null {
  const text = Object.hasOwn(TEXTS, name) ? TEXTS[name] : undefined
  const changed = Object.hasOwn(OUR_SKILL_CHANGES, name) ? OUR_SKILL_CHANGES[name] : undefined
  if (text === undefined || !changed) return null
  // A leading HTML comment (Skill Creator's licence note) is for the file, not the page.
  return { body: stripFrontmatter(text).replace(/^<!--[\s\S]*?-->\s*/, ''), changedAtMs: Date.parse(`${changed.changedOn}T00:00:00Z`) }
}
