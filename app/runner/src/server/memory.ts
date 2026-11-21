// Memory for the health route, without the cgroup files (P0 S1 couldn't read them in the container): the machine's
// view from /proc/meminfo and this process's own from process.memoryUsage().
import { readFileSync } from 'node:fs'
import type { Health } from '../../../shared/protocol/index.ts'

export function parseMeminfo(text: string): { totalBytes: number | null; availableBytes: number | null } {
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  return { totalBytes: kb('MemTotal'), availableBytes: kb('MemAvailable') }
}

export function readMemory(): Health['memory'] {
  let meminfo: { totalBytes: number | null; availableBytes: number | null } = { totalBytes: null, availableBytes: null }
  try {
    meminfo = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'))
  } catch (e) {
    // Only a machine without /proc (a developer's Mac) lands here; anything else is a real fault.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const usage = process.memoryUsage()
  return { ...meminfo, rssBytes: usage.rss, heapUsedBytes: usage.heapUsed }
}
