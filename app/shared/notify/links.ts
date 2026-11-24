// The app links a notice may carry (P5 W4, p5-w4.md section 5, OC-W4-1 and OC-W4-8). Pure, with no imports at all, so
// the hub's bundle can include it as well as the server. A link is never parsed out of model text: it comes from a typed
// `{ kind, id? }` and this table alone turns it into a path (Slack) or the bell's link (P4's notice link shape).
// Deviation agreed with the orchestrator (B2, 2026-11-21): P4's bell link has no approval or routine id, so those go to
// their page on the bell while Slack keeps the id in its path.

export const LINK_KINDS = ['approval', 'chat', 'today', 'activity', 'routine'] as const
export type LinkKind = (typeof LINK_KINDS)[number]

export type NoticeLinkInput = { kind: LinkKind; id?: string }

/** P4's bell link (`AgentNotificationSchema.shape.link`), written out here so this file imports nothing. */
export type BellLink = { to: 'page'; page: 'today' | 'approvals' | 'activity' | 'routines' } | { to: 'chat'; id: string }

/** The app's id rule for chats, approvals and routines (P3's chat id, P4's notice link id). */
const APP_ID = /^[A-Za-z0-9_-]{1,64}$/

type Row = { needsId: boolean; path: (id: string) => string; bell: (id: string) => BellLink }

const TABLE: Readonly<Record<LinkKind, Row>> = {
  approval: { needsId: true, path: id => `/approvals/${id}`, bell: () => ({ to: 'page', page: 'approvals' }) },
  chat: { needsId: true, path: id => `/chats/${id}`, bell: id => ({ to: 'chat', id }) },
  today: { needsId: false, path: () => '/', bell: () => ({ to: 'page', page: 'today' }) },
  activity: { needsId: false, path: () => '/activity', bell: () => ({ to: 'page', page: 'activity' }) },
  routine: { needsId: true, path: id => `/routines/${id}`, bell: () => ({ to: 'page', page: 'routines' }) },
}

export const isLinkKind = (v: unknown): v is LinkKind => typeof v === 'string' && (LINK_KINDS as readonly string[]).includes(v)

/**
 * The checked link, or null when it can't be used (an unknown kind, a missing or malformed id where one is needed, an
 * id where none is). Null means the link is dropped and the caller records that.
 */
export function checkLink(link: unknown): NoticeLinkInput | null {
  if (typeof link !== 'object' || link === null) return null
  const { kind, id } = link as { kind?: unknown; id?: unknown }
  if (!isLinkKind(kind)) return null
  const row = TABLE[kind]
  if (row.needsId) return typeof id === 'string' && APP_ID.test(id) ? { kind, id } : null
  return id === undefined ? { kind } : null
}

/** The app path for a checked link (Slack composes `APP_ORIGIN + path`). Null for an unusable link. */
export function linkPath(link: unknown): string | null {
  const ok = checkLink(link)
  return ok ? TABLE[ok.kind].path(ok.id ?? '') : null
}

/** The bell's link for a checked link; Today when there's none or it's unusable (P4's notices always carry a link). */
export function bellLink(link: unknown): BellLink {
  const ok = checkLink(link)
  return ok ? TABLE[ok.kind].bell(ok.id ?? '') : { to: 'page', page: 'today' }
}
