// The skills the agent has (P6a W3): `dataviz`, the one bundled skill we keep, and our three file skills. The Skills page
// reads this list (route 79); a test in build-support/ fails if it and the runner's `ALLOWED_SKILLS` ever differ.
import type { SkillDef } from '../../shared/contract/skill.ts'

/** Plugin-qualified names are the runner's (`inhouse:pdf`); the page shows the plain name. */
export const SKILLS: readonly SkillDef[] = [
  { n: 'dataviz', d: 'Turns numbers into clear charts and tables.', icon: 'monitoring', need: 0, by: 'Inhouse team', used: '' },
  { n: 'pdf', d: 'Makes a PDF, or reads one you attach.', icon: 'picture_as_pdf', need: 0, by: 'Inhouse team', used: '' },
  { n: 'word', d: 'Makes a Word document, or reads and updates one you attach.', icon: 'description', need: 0, by: 'Inhouse team', used: '' },
  { n: 'spreadsheet', d: 'Makes an Excel workbook or a CSV file, or reads one you attach.', icon: 'grid_view', need: 0, by: 'Inhouse team', used: '' },
]
