// The files the real client's composer holds until the message is sent (a chip's `pending` key names one). The chip itself
// is plain data in the store; a `File` can't be saved or compared, so it waits here. Nothing is kept past the send.
import type { Attachment } from '../agent/types'

const held = new Map<string, File>()

/** Holds a file and answers the key its chip carries. The key is unique to this page load, so a chip saved before a reload can never name a file held after it. */
export function keepFile(file: File): string {
  const key = `pending-${crypto.randomUUID()}`
  held.set(key, file)
  return key
}
export const heldFile = (key: string): File | undefined => held.get(key)
/** Lets go of a file: its chip was removed, or the file is on the server now. */
export const dropFile = (key: string): void => { held.delete(key) }

/** A saved chip without its key: the page it was held on is gone, so there is no file to send. */
export const withoutPending = (atts: readonly Attachment[]): Attachment[] => atts.map(a => { const { pending: _, ...rest } = a; return rest })
