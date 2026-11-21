// A listed file as the viewer sees it (p4-w5 sections 1 and 4). The chat-title rule (OC 2): a chat output names its chat
// (title and link) only to the chat's owner; everyone else reads "From a chat by <name>", since a title can reveal the
// conversation. A deleted chat has no link (there's nothing to open). A routine run's output links to the Routines page.
import { LibraryFileSchema } from '../../shared/contract/library.ts'
import type { LibraryFile } from '../../shared/contract/library.ts'
import { libraryDownloadPath } from '../../shared/contract/files.ts'
import type { Principal } from '../auth/principal.ts'
import { instantOf } from '../activity/render.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { formatSize, kindOf } from './kinds.ts'
import type { LibraryRow } from './store.ts'

const AGENT = 'Inhouse agent'
const FORMER = 'a former member'

/** The member id of whoever views (a person or the Inhouse team), or null for a service. */
export const viewerOf = (p: Principal): string | null => (p.kind === 'person' || p.kind === 'inhouse' ? p.memberId : null)

export function libraryFile(row: LibraryRow, viewerId: string | null, text: string | undefined): LibraryFile {
  const { kind, type } = kindOf(row.content_type)
  const base = {
    id: row.id, name: row.name, type, kind, size: formatSize(row.bytes), at: instantOf(row.at_ms), rev: row.rev,
    // OC 4: anyone the Library lists a file to may delete or restore it.
    canDelete: true,
    ...(kind === 'images' ? { src: libraryDownloadPath(row.id), alt: '' } : {}),
    ...(text !== undefined ? { text } : {}),
  }
  if (row.source === 'upload') {
    const by = row.person_name ?? FORMER
    return LibraryFileSchema.parse({ ...base, place: 'uploads', from: `Uploaded by ${by}`, by, madeByAgent: false })
  }
  if (row.owner_id === SYSTEM_MEMBER_ID) {
    return LibraryFileSchema.parse({ ...base, place: 'routines', from: 'From a routine', link: { to: 'routines' }, by: AGENT, madeByAgent: true })
  }
  const own = viewerId !== null && viewerId === row.owner_id
  const from = own ? `Chat: ${row.chat_title ?? ''}` : `From a chat by ${row.person_name ?? FORMER}`
  const link = own && row.chat_deleted === 0 && row.chat_id !== null ? { link: { to: 'chat' as const, id: row.chat_id } } : {}
  return LibraryFileSchema.parse({ ...base, place: 'chats', from, ...link, by: AGENT, madeByAgent: true })
}
