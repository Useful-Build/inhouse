// A ShopifyReadClient built on H0's own pieces (requestGrant, checkGrantedScopes, checkReadDocument, sendRead): the
// code the hub runs, minus SignIn and its storage. The live script and the recorder's differential use it. It grants
// once, lazily, and never exposes the token.
import type { HubResult } from '../../../hub/index/contract'
import { err, ok } from '../../../hub/index/errors'
import type { ShopifyReadClient } from '../../../hub/registry/registry'
import { checkReadDocument } from '../../../hub/scope/graphql'
import { checkGrantedScopes, describeScopeMismatch } from '../../../hub/scope/scopes'
import { requestGrant, sendRead, type ShopifyConfig, type Upstream } from '../../../hub/signin/providers/shopify'

export type HubReadClient = ShopifyReadClient & { grant(): Promise<HubResult<string[]>> }

export function hubReadClient(
  upstream: Upstream,
  config: ShopifyConfig,
  scopes: { read: readonly string[]; required: readonly string[] },
  apiVersion: string,
): HubReadClient {
  let token: Promise<HubResult<{ token: string; scopes: string[] }>> | null = null
  const grant = () =>
    (token ??= (async () => {
      const g = await requestGrant(upstream, config, () => 0)
      if (!g.ok) return err(g.code)
      const check = checkGrantedScopes(g.scope, scopes)
      if (!check.ok) return err('scope_mismatch', describeScopeMismatch(check))
      return ok({ token: g.accessToken, scopes: check.scopes })
    })())
  return {
    async grant() {
      const g = await grant()
      return g.ok ? ok(g.value.scopes) : g
    },
    async graphql(document, variables, version) {
      const doc = checkReadDocument(document)
      if (!doc.ok) return err(doc.code)
      const g = await grant()
      if (!g.ok) return g
      const sent = await sendRead(upstream, config, g.value.token, version ?? apiVersion, document, variables)
      return sent.kind === 'result' ? sent.result : err('credentials_rejected')
    },
  }
}
