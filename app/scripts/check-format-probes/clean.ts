// Intl.DateTimeFormat and toLocaleString in a comment, and getHours() in one: none of these count.
/* new Date().toLocaleString(); Intl.NumberFormat */
export const prose = 'The Intl API and toLocaleString are not called here'
export const utc = new Date(0).getUTCHours() + new Date(0).getUTCDate()
export type Options = Intl.DateTimeFormatOptions
export const url = 'https://example.com//path'
