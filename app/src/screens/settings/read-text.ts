// A setting's value as text, for a row shown read-only (a phone, or a viewer whose role can't change it).
import type { Row } from './content'

/** The parts of the text: a `display` label ("Choose a channel") wins over a saved value's label, which wins over the value. A mode row says whether the team can use it. */
export function readParts(row: Row, on: boolean): string[] | string {
  if (row.kind === 'mode') return [row.value, row.switchOn ? 'team can use it' : 'turned off']
  if (row.kind === 'toggle') return on ? 'On' : 'Off'
  if (row.kind === 'select') return [row.display ?? row.labels?.[row.value] ?? row.value, ...(row.tag ? [row.tag] : [])]
  // Show the allowed websites on one line. A `display` says when the list isn't what decides (any public website, M3-J);
  // else an empty list blocks all websites (the Inhouse team set the mode to `list`).
  if (row.type === 'hosts') return row.display ?? (row.value ? row.value.split('\n').join(', ') : 'No websites')
  return row.value
}
