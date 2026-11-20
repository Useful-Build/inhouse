// An Intl formatter other than DateTimeFormat and NumberFormat, and Intl reached through globalThis.
export const a = new Intl.RelativeTimeFormat('en').format(-1, 'day')
export const b = new globalThis['Intl'].PluralRules('en').select(1)
