// A run in miniature for door-resilience.test.ts (#711, #712, #716): starts one wrangler call (a stub bin standing in for
// npx) and, once the stub's child has written its pid, either prints "ready" and waits to be killed (`wait`), exits at once
// with the call still running (`exit`), or (`shield`) first shields its wrangler calls as a cancel does, takes SIGINT
// itself as the runners do, and waits. Usage: node wrangler-holder.ts <stub bin> <pid file> wait|exit|shield
import { existsSync } from 'node:fs'
import { shieldWranglerCalls, spawnWrangler } from '../door.ts'

const [bin, pidFile, mode] = process.argv.slice(2)
if (mode === 'shield') {
  shieldWranglerCalls()
  process.on('SIGINT', () => { process.stdout.write('sigint\n') })
}
void spawnWrangler(['d1', 'execute'], { PATH: process.env.PATH, PIDFILE: pidFile }, { bin: [bin!], timeoutMs: 60_000 })
const deadline = Date.now() + 10_000
while (!existsSync(pidFile!) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
if (mode === 'exit') process.exit(0)
process.stdout.write('ready\n')
await new Promise(() => {})
