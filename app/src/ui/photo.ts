// Profile photo upload: the checks, and the crop to a centred 256 px square.
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp']
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024
const SIZE = 256

/** The file could not be decoded as an image. */
export class PhotoDecodeError extends Error {}

/** The data URL of the file's centred square, scaled to 256 px. Rejects with `PhotoDecodeError` if the file isn't a readable image. */
export async function squarePhoto(file: File): Promise<string> {
  const bmp = await createImageBitmap(file).catch((e: unknown) => { throw new PhotoDecodeError('Not a readable image', { cause: e }) })
  try {
    const side = Math.min(bmp.width, bmp.height)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = SIZE
    const g = canvas.getContext('2d')
    if (!g) throw new Error('No canvas')
    g.fillStyle = '#fff'
    g.fillRect(0, 0, SIZE, SIZE)
    g.imageSmoothingQuality = 'high'
    g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, SIZE, SIZE)
    return canvas.toDataURL('image/jpeg', 0.9)
  } finally {
    bmp.close()
  }
}
