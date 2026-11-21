// Whether the open chat id is judged unknown (and the app opens another chat in its place). Ways it could break, written first:
//  - a chat link opened in a fresh tab is judged unknown while the chat list is still on its way (the list is empty until
//    route 22 answers), so the link is replaced by New chat before the chat can show;
//  - a truly unknown id is never judged once the list is in (a stale or deleted link keeps its notice and its redirect);
//  - a failed list read judges every link unknown (the person's chat is bounced because the network blinked);
//  - the demo (no server list; its Loading scenario) changes: it is judged as before, so its checks hold.
import { describe, expect, test } from 'vitest'
import { isChatUnknown } from './chat-known'

const base = { page: 'chats', chatList: false, openKey: 'c_x', ids: ['c_a'], serverList: 'ready' as 'loading' | 'ready' | 'error' | null }

describe('isChatUnknown', () => {
  test('a link to a chat the list lacks is unknown once the list has loaded', () => {
    expect(isChatUnknown(base)).toBe(true)
  })
  test('a link to a chat the list has is known', () => {
    expect(isChatUnknown({ ...base, openKey: 'c_a' })).toBe(false)
  })
  test('while the server list is loading, nothing is judged unknown (the fresh-tab link)', () => {
    expect(isChatUnknown({ ...base, ids: [], serverList: 'loading' })).toBe(false)
  })
  test('a failed list read judges nothing either', () => {
    expect(isChatUnknown({ ...base, ids: [], serverList: 'error' })).toBe(false)
  })
  test('with no server list (the demo) it is judged by the entries alone, loading or not', () => {
    expect(isChatUnknown({ ...base, serverList: null })).toBe(true)
  })
  test('other pages, the list of chats and a new chat are never unknown', () => {
    expect(isChatUnknown({ ...base, page: 'today' })).toBe(false)
    expect(isChatUnknown({ ...base, chatList: true })).toBe(false)
    expect(isChatUnknown({ ...base, openKey: null })).toBe(false)
  })
})
