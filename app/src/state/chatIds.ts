// Phase-1 UI rule, kept out of the agent contract (agent/types.ts).

/** A chat a person starts here has an id with this prefix (unique per page load). The store keeps such chats, and what
 *  was added to them, across a reload until Reset demo. */
export const STARTED_CHAT_PREFIX = 'chat-new-'
