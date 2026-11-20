// What the account menu's Sign out does: the product goes to Access's logout (`signOutUrl()`), the demo has no sign-in and says so.
export const signOutAction = (url: string | null): { go: string } | { demo: true } => (url ? { go: url } : { demo: true })
