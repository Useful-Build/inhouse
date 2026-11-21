// A problem's severity dot. The sample data gives `sev` as its own hex, "b23c22 = urgent,
// b97a14 = soon" by its legend; the dot takes the theme's colors for those instead, so it follows light and dark.
const SEV_CLASS: Record<string, string> = { b23c22: 'bg-destructive', b97a14: 'bg-warning' }

/** The token class for a problem's `sev`. Anything the legend doesn't name shows as a neutral dot. */
export const sevClass = (sev: string) => SEV_CLASS[sev.replace(/^#/, '').toLowerCase()] ?? 'bg-faint'

/** Urgent: the sample data's b23c22. The cards and the review panel lead with an Urgent pill for it; anything else gets no marker. */
export const isUrgent = (sev: string) => sevClass(sev) === 'bg-destructive'
