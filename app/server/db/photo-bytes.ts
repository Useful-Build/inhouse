// A photo's type from its first bytes only (p2-design section 3, route 13): PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG
// `FF D8 FF`, WebP `RIFF....WEBP`. Anything else is not a photo, whatever its Content-Type says.

export type PhotoType = 'image/png' | 'image/jpeg' | 'image/webp'

/** The largest photo, in bytes (1 MiB). */
export const MAX_PHOTO_BYTES = 1024 * 1024

const starts = (b: Uint8Array, sig: readonly number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v)

export function photoType(bytes: Uint8Array): PhotoType | null {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (starts(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
  return null
}
