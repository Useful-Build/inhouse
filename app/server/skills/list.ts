// The skills the agent has (P6a W3, and Skill Creator from P6a's brand skills): `dataviz`, the one bundled skill we keep,
// and our own. The Skills page reads this list (route 79) with the brand's own skills after it; a test in
// build-support/ fails if it and the runner's `ALLOWED_SKILLS` ever differ.
import type { SkillDef } from '../../shared/contract/skill.ts'

/** Plugin-qualified names are the runner's (`inhouse:pdf`); the page shows the plain name. */
export const SKILLS: readonly SkillDef[] = [
  { n: 'dataviz', d: 'Turns numbers into clear charts and tables.', icon: 'monitoring', need: 0, by: 'Inhouse team', used: '' },
  { n: 'pdf', d: 'Makes a PDF, or reads one you attach.', icon: 'picture_as_pdf', need: 0, by: 'Inhouse team', used: '' },
  { n: 'word', d: 'Makes a Word document, or reads and updates one you attach.', icon: 'description', need: 0, by: 'Inhouse team', used: '' },
  { n: 'spreadsheet', d: 'Makes an Excel workbook or a CSV file, or reads one you attach.', icon: 'grid_view', need: 0, by: 'Inhouse team', used: '' },
  { n: 'skill-creator', d: 'Helps you make a skill for your team in a chat, try it out and save it.', icon: 'auto_awesome', need: 0, by: 'Inhouse team', used: '' },
]

/**
 * When each of our skills last changed (route 84's `updatedAt`), and the SHA-256 of the SKILL.md it ships (dataviz's
 * summary is ours, in pages.ts: null). build-support/skills.test.ts fails when a SKILL.md changes without both here.
 */
export const OUR_SKILL_CHANGES: Readonly<Record<string, { changedOn: string; sha256: string | null }>> = {
  dataviz: { changedOn: '2026-11-23', sha256: null },
  pdf: { changedOn: '2026-11-22', sha256: '7d51080b1568e964b9ee51ba6dff3ec21859f6490cdebfc0712a59d2327cd8db' },
  word: { changedOn: '2026-11-22', sha256: '57c6c92cb20d0d033342efc3cc85ae3e202040faa25815a10357065b64d69961' },
  spreadsheet: { changedOn: '2026-11-22', sha256: 'ded0f0e35e459ec15373637d647abf46aa9814057b7d0f9ba827a45ab081baf8' },
  'skill-creator': { changedOn: '2026-11-23', sha256: '75cd478b27a4480e911f7f810506f82e85fbc651022685920de355cad55c6a4b' },
}
