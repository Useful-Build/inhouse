// Whether the open chat id names a chat that isn't there (a stale or typed link, a deleted chat). Apart from the store so a
// test can reach it.

/**
 * `serverList`: the state of the server's chat list read (the real client), or null where there is none (the demo, which
 * judges by its entries alone). The list is empty until it answers, so a link opened in a fresh tab is judged only once it
 * has: before that, and after a failed read, nothing is unknown. The list is one page, so a chat it lacks may just be older:
 * it is unknown once route 24 was asked for it (`looked`) and it still isn't in the list (a 404, or a deleted chat).
 */
export function isChatUnknown(o: { page: string; chatList: boolean; openKey: string | null; ids: readonly string[]; serverList: 'loading' | 'ready' | 'error' | null; looked: boolean }): boolean {
  if (o.page !== 'chats' || o.chatList || o.openKey === null) return false
  if (o.serverList !== null && (o.serverList !== 'ready' || !o.looked)) return false
  return !o.ids.includes(o.openKey)
}
