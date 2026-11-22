// House release markers. The backend plan ("Releases") says a phase reaches the house deployment only as a tag on its
// merge commit, but this repo names no house tag format yet (deploy.yml's vYYYY.MM.DD.N tags are the demo's). This file
// reads the proposed one: an annotated tag `house-<YYYYMMDD>-<n>` whose subject line is `live=P4,P5 behaviour=yes|no`.
// A subject that is missing or unreadable counts as a behaviour change with no phases, so a mistake restarts the
// window instead of hiding a release. The tag's creation time is when it went live.
import { execFileSync } from 'node:child_process'
import type { ReleaseMarker } from './types.ts'

export const HOUSE_TAG = /^house-\d{8}-\d+$/

/** One line per tag: `tag<TAB>unix seconds<TAB>subject`. Lines that aren't house tags are ignored. */
export function parseMarkers(lines: readonly string[]): ReleaseMarker[] {
  const out: ReleaseMarker[] = []
  for (const line of lines) {
    const [tag = '', secs = '', ...rest] = line.split('\t')
    if (!HOUSE_TAG.test(tag)) continue
    const at = Number(secs)
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error(`release tag ${tag} has no creation time`)
    const subject = rest.join('\t')
    const live = /(?:^|\s)live=([A-Za-z0-9,]*)/.exec(subject)?.[1]
    const behaviour = /(?:^|\s)behaviour=(yes|no)(?:\s|$)/.exec(subject)?.[1]
    out.push({ tag, atMs: at * 1000, behaviour: behaviour !== 'no', live: live ? live.split(',').filter(Boolean) : [] })
  }
  return out.sort((a, b) => a.atMs - b.atMs)
}

/** The house tags of the repo at `cwd`. */
export function readMarkers(cwd: string): ReleaseMarker[] {
  const out = execFileSync('git', ['for-each-ref', '--format=%(refname:short)%09%(creatordate:unix)%09%(contents:subject)', 'refs/tags/house-*'], { cwd, encoding: 'utf8' })
  return parseMarkers(out.split('\n').filter(Boolean))
}
