// The read-only document check. Runs inside SignIn.query, the last point before a token is used, so no tool code can
// skip it. Refuses: over 20,000 characters or unparsable (`invalid_args`); no operation or more than one
// (`invalid_args`); any mutation or subscription (`write_refused`). Fragments are fine.
import { Kind, parse, type DocumentNode } from 'graphql'

export const MAX_DOCUMENT_CHARS = 20_000

export type DocumentCheck = { ok: true } | { ok: false; code: 'invalid_args' | 'write_refused' }

export function checkReadDocument(document: unknown): DocumentCheck {
  if (typeof document !== 'string' || document.length > MAX_DOCUMENT_CHARS) return { ok: false, code: 'invalid_args' }
  let ast: DocumentNode
  try {
    ast = parse(document, { noLocation: true })
  } catch {
    return { ok: false, code: 'invalid_args' }
  }
  const operations = ast.definitions.filter(d => d.kind === Kind.OPERATION_DEFINITION)
  if (operations.some(op => op.operation !== 'query')) return { ok: false, code: 'write_refused' }
  if (operations.length !== 1) return { ok: false, code: 'invalid_args' }
  return { ok: true }
}
