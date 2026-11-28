// A run in miniature for door-resilience.test.ts (#711, #712): starts one wrangler call (a stub bin standing in for npx)
// and, once the stub's child has written its pid, either prints "ready" and waits to be killed (`wait`), or exits at once
// with the call still running (`exit`). Usage: node wrangler-holder.ts <stub bin> <pid file> wait|exit
import { existsSync } from 'node:fs'
import { spawnWrangler } from '../door.ts'

const [bin, pidFile, mode] = process.argv.slice(2)
void spawnWrangler(['d1', 'execute'], { PATH: process.env.PATH, PIDFILE: pidFile }, { bin: [bin!], timeoutMs: 60_000 })
const deadline = Date.now() + 10_000
while (!existsSync(pidFile!) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
if (mode === 'exit') process.exit(0)
process.stdout.write('ready\n')
await new Promise(() => {})
