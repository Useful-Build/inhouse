// Stage 1 M3-U (N33): the plain counting words a batch's title uses. No imports: the operation entries are read outside
// the Worker too (the evals' node project, #550), so nothing they pull in may reach the Worker's D1 or R2 types.

/** A list in UI words, no Oxford comma: "VIP", "VIP and rush", "VIP, rush and gift". */
export function andList(xs: readonly string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
}
/** A count and its noun, the noun singular for one: "450 orders", "1 order". */
export const countOf = (n: number, one: string, many: string): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
