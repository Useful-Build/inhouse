// Paths under `inputs/` and `outputs/` without following a symlink on the way (P3 R1 review round 1). The files code
// runs in the session process, unsandboxed, as the session's user; the agent's tools can write both folders. A symlink
// planted there (a folder itself, a subfolder, a file, a temp name) must never lead the files code to read or write
// anything outside them.
//
// On Linux (production) every step goes through the parent folder's open handle, as `/proc/self/fd/<fd>/<name>`: the
// openat() Node lacks. Only `<name>` is looked up, with O_NOFOLLOW where it's opened, so a folder swapped for a symlink
// between two steps can't redirect it. Elsewhere (a development Mac) there's no such path: each step goes by full path
// with O_NOFOLLOW on its last component, which refuses a symlink already there but not one swapped in mid-step.
import { constants, existsSync, type Stats } from 'node:fs'
import { lstat, open, readdir, type FileHandle } from 'node:fs/promises'

const VIA_PROC = process.platform === 'linux' && existsSync('/proc/self/fd')
const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK } = constants

/** A path component that is a symlink (or isn't the kind asked for): never followed. */
export class NotFollowed extends Error {
  constructor(what: string) {
    super(`not followed: ${what}`)
  }
}

/** An open folder. `path` is for messages and the non-Linux fallback; lookups go through `fh` on Linux. */
export type Dir = { fh: FileHandle; path: string }

/** `name` inside `dir`, looked up through the folder's handle (Linux) or its path. */
export const inDir = (dir: Dir, name: string): string => (VIA_PROC ? `/proc/self/fd/${dir.fh.fd}/${name}` : `${dir.path}/${name}`)

const refusedLink = (e: unknown) => ['ELOOP', 'ENOTDIR', 'EMLINK'].includes((e as NodeJS.ErrnoException).code ?? '')

async function openDirAt(lookup: string, path: string): Promise<Dir> {
  let fh: FileHandle
  try {
    fh = await open(lookup, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  } catch (e) {
    if (refusedLink(e)) throw new NotFollowed(path)
    throw e
  }
  if (!(await fh.stat()).isDirectory()) {
    await fh.close()
    throw new NotFollowed(path)
  }
  return { fh, path }
}

/** Opens a folder that must be a real one, not a symlink to one. */
export const openDir = (path: string): Promise<Dir> => openDirAt(path, path)

/** Opens the folder `name` inside `dir`; it must be a real folder. */
export const openChild = (dir: Dir, name: string): Promise<Dir> => openDirAt(inDir(dir, name), `${dir.path}/${name}`)

/** Opens the folder `segments` below `root`, one real folder at a time. The caller closes it (not `root`). */
export async function openBelow(root: Dir, segments: string[]): Promise<Dir> {
  let dir = root
  for (const s of segments) {
    const next = await openChild(dir, s).finally(() => (dir === root ? undefined : dir.fh.close()))
    dir = next
  }
  // No segments: a handle of its own, so the caller can always close what it got.
  return dir === root ? openChild(root, '.') : dir
}

export const closeDir = (dir: Dir) => dir.fh.close().catch(() => undefined)

/** The entries of an open folder. */
export const list = (dir: Dir) => readdir(VIA_PROC ? `/proc/self/fd/${dir.fh.fd}` : dir.path, { withFileTypes: true })

/** lstat of `name` inside `dir`: a symlink is reported as one, never followed. */
export const lstatIn = (dir: Dir, name: string): Promise<Stats> => lstat(inDir(dir, name))

/**
 * Reads the regular file `name` inside `dir`, which lstat said was `seen`. Opened without following a symlink and
 * without blocking (a FIFO swapped in can't hang it); refused unless the open file is a regular file with one link and
 * the same device, inode and size as `seen`, and its size didn't change while it was read.
 */
export async function readFileIn(dir: Dir, name: string, seen: Stats): Promise<Uint8Array> {
  const fh = await open(inDir(dir, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try {
    const st = await fh.stat()
    if (!st.isFile() || st.nlink !== 1 || st.dev !== seen.dev || st.ino !== seen.ino || st.size !== seen.size) throw new Error('not the file that was checked')
    const buf = Buffer.alloc(seen.size + 1)
    let n = 0
    for (;;) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n)
      if (bytesRead === 0) break
      n += bytesRead
      if (n > seen.size) throw new Error('grew while being read')
    }
    if (n !== seen.size) throw new Error('shrank while being read')
    return buf.subarray(0, n)
  } finally {
    await fh.close()
  }
}
