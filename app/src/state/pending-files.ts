// The files the real client's composer holds until the message is sent (a chip's `pending` key names one). The chip itself
// is plain data in the store; a `File` can't be saved or compared, so it waits here. Nothing is kept past the send.
const held = new Map<string, File>()
let seq = 0

/** Holds a file and answers the key its chip carries. */
export function keepFile(file: File): string {
  const key = `pending-${++seq}`
  held.set(key, file)
  return key
}
export const heldFile = (key: string): File | undefined => held.get(key)
/** Lets go of a file: its chip was removed, or the file is on the server now. */
export const dropFile = (key: string): void => { held.delete(key) }
