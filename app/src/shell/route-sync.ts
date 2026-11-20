// The address bar and the app's state follow each other: a change in the app writes the hash, a change to the hash (a
// typed link, Back, a script) is read into the app by the `hashchange` listener in App.tsx. The write must never beat a
// hash someone else set: the hash event arrives after the effect that would write, so when the app re-renders for another
// reason in between (a phone-width resize flips `phone`), the effect would put the old page back and the person's change
// would be lost.

/**
 * Whether the app may write its own hash now. False when nothing about where the app is changed since the last write
 * (`navChanged` false: only a layout or data change re-ran the effect) yet the hash names another route: someone set it, and
 * the listener will read it.
 */
export const mayWriteHash = (navChanged: boolean, current: string, own: string, readable: boolean): boolean => navChanged || current === own || !readable
