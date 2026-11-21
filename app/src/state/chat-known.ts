// Whether the open chat id names a chat that isn't there (a stale or typed link, a deleted chat). Apart from the store so a
// test can reach it.

/**
 * `serverList`: the state of the server's chat list read (the real client), or null where there is none (the demo, which
 * judges by its entries alone). The list is empty until it answers, so a link opened in a fresh tab is judged only once it
 * has: before that, and after a failed read, nothing is unknown.
 */
export function isChatUnknown(o: { page: string; chatList: boolean; openKey: string | null; ids: readonly string[]; serverList: 'loading' | 'ready' | 'error' | null }): boolean {
  if (o.page !== 'chats' || o.chatList || o.openKey === null) return false
  if (o.serverList !== null && o.serverList !== 'ready') return false
  return !o.ids.includes(o.openKey)
}
