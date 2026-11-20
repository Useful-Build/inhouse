// The release step's first Admin (P2 plan, "Releases"): renders their invite and its `member.invited` line (actor: the
// system row) as SQL for `wrangler d1 execute <db> --remote --file <out>`, from the data layer's own statement builders.
// Every value is checked by the contract's schema first and written as an SQLite literal. The insert is guarded, so
// running the file twice invites once and logs once. Usage (in app/):
//   node server/seed/first-admin.ts --name "<name>" --email <email> [--title "<title>"] > first-admin.sql
import { InviteInputSchema } from '../../shared/contract/members.ts'
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { newInviteStmts } from '../db/members.ts'
import { renderStmt, stmt } from '../db/sql.ts'

/** The SQL statements, one string each, for the first Admin's invite at `nowMs`. Throws on a value the schema refuses. */
export function firstAdminSql(input: { name: string; email: string; title?: string }, nowMs: number, requestId: string = `release-${crypto.randomUUID()}`): string[] {
  const invite = InviteInputSchema.parse({ ...input, role: 'admin' })
  const built = newInviteStmts(invite, { actorId: SYSTEM_MEMBER_ID, requestId, nowMs })
  // The stamp is spent once its line is written, so running this same file again matches no row and adds no line.
  const spend = stmt('UPDATE members SET req_id = ? WHERE id = ? AND req_id = ?', requestId, built.id, built.stamp)
  return [...built.stmts, spend].map(renderStmt)
}

const proc = (globalThis as unknown as { process?: { argv: string[]; exitCode?: number } }).process
if (proc && (import.meta as { main?: boolean }).main) {
  const args = proc.argv.slice(2)
  const flags: Record<string, string> = {}
  let ok = args.length % 2 === 0
  for (let i = 0; ok && i < args.length; i += 2) {
    const name = /^--(name|email|title)$/.exec(args[i])?.[1]
    if (!name || Object.hasOwn(flags, name)) ok = false
    else flags[name] = args[i + 1]
  }
  if (!ok || !flags.name || !flags.email) {
    console.error('first-admin: usage: node server/seed/first-admin.ts --name "<name>" --email <email> [--title "<title>"]')
    proc.exitCode = 2
  } else {
    try {
      console.log(firstAdminSql({ name: flags.name, email: flags.email, ...(flags.title ? { title: flags.title } : {}) }, Date.now()).join('\n'))
    } catch (err) {
      console.error('first-admin: refused, a value is not valid', err instanceof Error ? err.message : '')
      proc.exitCode = 1
    }
  }
}
