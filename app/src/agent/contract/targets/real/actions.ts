// Stage 1 M2-H's part of the real target, in the style of memory-skills.ts: which of the N18 methods the real client
// serves over HTTP, how an action is put waiting for the signed-in Admin, how its send is made to end as "Needs a check",
// and how the reset leaves no permission of the Admin's behind. index.ts wires it (`SERVED`, `seedAction`, `failNextSend`,
// `reset`).
//
// The action comes from the test-fakes hook's `action` op (server/ops/test-fakes.ts, M2-B), the outbox's own `request` as
// the Admin with no tool call behind it. The reset removes every permission first, so the request always makes a card
// (never a send under a permission a case left). The operation is turned on first with the hook's `ceiling` op: the test
// build's only way (N2). The send goes to the hub's fake Shopify write store; its fault switch makes the store hang until
// the dispatcher's 15 s limit, an unclear result the dispatcher records as "Needs a check" (N11). (Not the store's
// unreadable-body fault: scripts/check-icons.mjs reads any underscored string in src/ as an icon name.) Before the first
// seed the hub's Shopify account is read once (e2e/support/test-build/shopify-read.ts): its first token grant gives it
// its connect date, which M2-D's sync copies into D1 on the request; the outbox refuses an account with none.
import type { JWK } from 'jose'
import { mintService } from '../../../../../server/auth/test-issuer-mint'
import type { AgentClient } from '../../../types'
import type { Signer } from './me'
import { SHOPIFY_READ } from '../../../../../e2e/support/test-build/shopify-read'

/** The N18 methods the real client serves over HTTP. `onActionUpdated` needs a run (a container), so no case reads it here. */
export const ACTIONS_SERVED = [
  'actions', 'action', 'answerAction', 'undoAction', 'resolveAction', 'permissions', 'removePermission', 'questions', 'answerQuestion',
] as const satisfies readonly (keyof AgentClient)[]

const OPERATION = 'shopify.order.tag_add'
/** One of the fake write store's orders (test/upstreams/shopify/write/server.ts). */
const ORDER = 'gid://shopify/Order/9002'

const env: Record<string, string | undefined> = (globalThis as unknown as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const need = (name: string): string => {
  const v = env[name]
  if (!v) throw new Error(`The real contract target's actions part needs ${name} in the environment: run it through e2e/support/test-build/serve.ts.`)
  return v
}

export interface ActionWorld {
  /** One action waiting on the Admin's answer, with a tag no other case used; answers its id. */
  seedAction(adminId: string): Promise<string>
  /** The next send of an approved action ends as "Needs a check" (true, after the hub's 15 s limit), or goes out (false). */
  failNextSend(on: boolean): Promise<void>
  /** No permission of the Admin's left (each removed at its rev), and sends go out again. */
  reset(s: Signer): Promise<void>
}

export function actionWorld(brandOrigin: string): ActionWorld {
  const key = JSON.parse(need('INHOUSE_TEST_ISSUER_PRIVATE_JWK')) as JWK
  const release = (): Promise<string> => mintService({ key, aud: need('CONTRACT_REAL_BRAND_AUD'), clientId: need('CONTRACT_REAL_RELEASE_CLIENT_ID') })
  /** The release token's hook (the fakes): the same route the API specs use. Answers its JSON. */
  const hook = async (body: Record<string, unknown>): Promise<any> => {
    const headers = { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': await release(), Origin: brandOrigin }
    const res = await fetch(`${brandOrigin}/api/ops/test-fakes`, { method: 'POST', headers, body: JSON.stringify(body) })
    const text = await res.text()
    if (res.status !== 200) throw new Error(`The test-fakes hook refused ${String(body.op)}: ${res.status} ${text}`)
    return JSON.parse(text)
  }
  let n = 0
  let account: Promise<void> | null = null
  /** The hub's Shopify account read once, so it has its connect date (the hub's first token grant). */
  const readAccount = async () => {
    const read = await hook({ ...SHOPIFY_READ })
    if (read?.ok !== true) throw new Error(`The real contract target's hub Shopify read failed: ${JSON.stringify(read)}`)
  }
  const fault = (f: 'succeed' | 'timeout') => hook({ op: 'set', shopifyWrite: { faults: { [OPERATION]: f } } })
  return {
    async seedAction(adminId) {
      await (account ??= readAccount().catch((e: unknown) => { account = null; throw e }))
      await hook({ op: 'ceiling', operation: OPERATION, enabled: true, perDayMax: 50 })
      // A tag of its own each time: a card waiting with the same arguments would be returned instead of a new one.
      const tag = `contract-${Date.now().toString(36)}-${++n}`
      const { result } = await hook({ op: 'action', as: { memberId: adminId }, operation: OPERATION, args: { orderIds: [ORDER], tags: [tag] } })
      if (result?.outcome !== 'waiting' || typeof result.action?.id !== 'string') throw new Error(`The real contract target couldn't put an action waiting: ${JSON.stringify(result)}`)
      return result.action.id as string
    },
    async failNextSend(on) { await fault(on ? 'timeout' : 'succeed') },
    async reset(s) {
      await fault('succeed')
      const r = await s.api('admin', 'GET', '/api/permissions')
      if (r.status !== 200) throw new Error(`The real contract target couldn't read the Admin's permissions: ${r.status}`)
      for (const p of r.json.items as { id: string; rev: number; holder: { kind: string; memberId?: string }; can: { remove: boolean } }[]) {
        if (!p.can.remove) continue
        const gone = await s.api('admin', 'POST', `/api/permissions/${encodeURIComponent(p.id)}/remove`, { ifRev: p.rev })
        if (gone.status !== 200 && gone.status !== 404) throw new Error(`The real contract target couldn't remove permission ${p.id}: ${gone.status}`)
      }
    },
  }
}
