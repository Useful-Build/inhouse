// CSV for the audit log export (p2-design section 8), shared by the server's export (route 20) and the demo's download.
// Every cell is quoted with `"` doubled inside; a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return
// gets a leading `'`, so a spreadsheet shows it as text instead of running it as a formula. Rows end in CRLF (RFC 4180).
// OWASP, CSV injection: https://owasp.org/www-community/attacks/CSV_Injection (read 2026-11-20)

const FORMULA_START = /^[=+\-@\t\r]/

/** One cell, quoted and defused. */
export function csvCell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value
  return `"${text.replaceAll('"', '""')}"`
}

/** One row, ending in CRLF. */
export const csvRow = (cells: readonly string[]): string => `${cells.map(csvCell).join(',')}\r\n`

/** The audit export's header row. */
export const AUDIT_CSV_HEADER = ['When', 'Who', 'What', 'Detail'] as const
