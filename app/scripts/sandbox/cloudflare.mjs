// The few Cloudflare REST calls the sandbox scripts make (list, create and delete Workers, custom domains, D1, R2 and
// container applications). Moved from the private ops repo (its house-only calls stay there).
// The token and account come from the caller; the token is only ever sent as the Authorization header and never logged.
// API reference (read 2026-11-20): https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/
// (force), .../workers/subresources/domains/ (list, detach), .../d1/subresources/database/methods/list/ (page, per_page),
// .../d1/subresources/database/methods/create/ (name), .../d1/subresources/database/methods/query/ (sql, params), .../r2/subresources/buckets/methods/list/ (cursor),
// .../r2/subresources/buckets/subresources/objects/methods/list/ (cursor, is_truncated), and the bucket and object
// delete calls on .../r2/subresources/buckets/, and .../containers/ (list and delete applications).
const BASE = 'https://api.cloudflare.com/client/v4'
// The container registry, as wrangler 4.162's `containers images list` and `images delete` reach it (read in its source,
// src/cloudchamber/images/images.ts): a 5-minute credential from POST .../containers/registries/<registry>/credentials
// (Basic `v1:<password>`), then the registry's own API: /v2/_catalog?tags=true, HEAD and DELETE
// /v2/<account>/<image>/manifests/<tag>, and PUT /v2/gc/layers.
const REGISTRY = 'https://registry.cloudflare.com'
const MANIFEST_ACCEPT = 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
const IMAGE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

export class CloudflareError extends Error {
  /** `status` and `errors` ([{ code, message }]) are set on an API answer, for callers that act on one code. */
  constructor(message, { status, errors } = {}) {
    super(message)
    this.status = status
    this.errors = errors ?? []
  }
}

// R2 blocks re-creating a deleted bucket's name for about a minute: 409, code 10073, "Bucket was deleted at <ISO time>;
// same-name recreation is blocked until <ISO time>" (seen in test-deploy run 45312321731; the R2 docs name no such code).
// The create waits until the time Cloudflare states, and only up to this cap (a stated time further out, or none we can
// read, fails loud).
const R2_RECREATE_CODE = 10073
const R2_RECREATE_CAP_MS = 120_000
const R2_RECREATE_MARGIN_MS = 2_000

/**
 * An R2 key this client may send in a URL path: no empty, '.' or '..' segment (each would be resolved or collapsed on
 * the way, so the request could reach another path). A key that fails is left in its bucket for a person.
 */
export const isSafeKey = key => typeof key === 'string' && key !== '' && key.split('/').every(s => s !== '' && s !== '.' && s !== '..')

/** A client for one account. `fetchImpl` is for tests. */
export function cloudflare({ token, accountId, fetchImpl = fetch, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log }) {
  if (!token) throw new CloudflareError('no Cloudflare API token')
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '')) throw new CloudflareError('the account id must be 32 lowercase hex')
  const seg = s => encodeURIComponent(s)
  // `root`: a path under the API's root (the zone calls), not under this account.
  async function call(method, path, { query, body, okStatus, root = false } = {}) {
    const full = root ? path : `/accounts/${accountId}${path}`
    const url = new URL(`${BASE}${full}`)
    // new URL() resolves '.' and '..' segments (and the like), so a name or key could climb out of its resource to
    // another account-level path. Every call goes out only on exactly the path it was built from.
    if (url.pathname !== `/client/v4${full}`) throw new CloudflareError(`refusing ${method} ${JSON.stringify(path)}: the URL resolves elsewhere`)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
    const res = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await res.json() } catch { json = null }
    if (okStatus?.includes(res.status)) return { status: res.status, json }
    if (!res.ok || json?.success === false) {
      const errors = (json?.errors ?? []).map(e => `${e.code}: ${e.message}`).join('; ')
      throw new CloudflareError(`${method} ${path} answered ${res.status}${errors ? ` (${errors})` : ''}`, { status: res.status, errors: json?.errors })
    }
    return { status: res.status, json }
  }
  /** A short-lived Basic header for the registry; the password is never logged. */
  async function registryAuth() {
    const { json } = await call('POST', '/containers/registries/registry.cloudflare.com/credentials', { body: { expiration_minutes: 5, permissions: ['pull', 'push'] } })
    const password = json?.result?.password
    if (typeof password !== 'string' || !password) throw new CloudflareError('the registry credentials answer has no password')
    return `Basic ${Buffer.from(`v1:${password}`).toString('base64')}`
  }
  return {
    /** Every Worker script's name. */
    async workers() {
      const { json } = await call('GET', '/workers/scripts')
      return (json.result ?? []).map(s => s.id)
    },
    /** Every Worker custom domain: { id, hostname, service }. A second page fails rather than hides a domain. */
    async domains() {
      const { json } = await call('GET', '/workers/domains')
      if ((json.result_info?.total_pages ?? 1) > 1) throw new CloudflareError('the custom domain listing has more than one page')
      return (json.result ?? []).map(d => ({ id: d.id, hostname: d.hostname, service: d.service }))
    },
    /** Every D1 database: { name, uuid }, all pages. */
    async d1() {
      const out = []
      for (let page = 1; ; page++) {
        const { json } = await call('GET', '/d1/database', { query: { page, per_page: 100 } })
        const rows = json.result ?? []
        out.push(...rows.map(d => ({ name: d.name, uuid: d.uuid })))
        if (rows.length < 100) return out
      }
    },
    /** Every R2 bucket's name, all pages. */
    // The docs give `result_info.cursor` ("a continuation token ... for the next page") but not what it is on the last
    // page, so a page ends the listing when it has no cursor, holds fewer than per_page buckets, or repeats a cursor.
    async r2() {
      const out = []
      const seen = new Set()
      let cursor
      for (;;) {
        const { json } = await call('GET', '/r2/buckets', { query: { per_page: 1000, cursor } })
        const page = json.result?.buckets ?? []
        out.push(...page.map(b => b.name))
        cursor = json.result_info?.cursor
        if (!cursor || page.length < 1000 || seen.has(cursor)) return out
        seen.add(cursor)
      }
    },
    /** Every object key in a bucket, all pages. */
    async r2Keys(bucket) {
      const out = []
      let cursor
      for (;;) {
        const { json } = await call('GET', `/r2/buckets/${seg(bucket)}/objects`, { query: { per_page: 1000, cursor } })
        out.push(...(json.result ?? []).map(o => o.key))
        if (!json.result_info?.is_truncated) return out
        cursor = json.result_info.cursor
      }
    },
    detachDomain: id => call('DELETE', `/workers/domains/${seg(id)}`),
    /** force: also when another Worker references it (its Durable Object namespaces go with it). */
    deleteWorker: name => call('DELETE', `/workers/scripts/${seg(name)}`, { query: { force: true } }),
    deleteD1: uuid => call('DELETE', `/d1/database/${seg(uuid)}`),
    // "Slashes (/) within the key MUST be sent literally and MUST NOT be percent-encoded" (Delete Object, read
    // 2026-11-20): encode each path segment, keep the slashes.
    deleteR2Object: async (bucket, key) => {
      if (!isSafeKey(key)) throw new CloudflareError(`refusing to delete R2 object ${JSON.stringify(key)}: an empty, '.' or '..' segment`)
      return call('DELETE', `/r2/buckets/${seg(bucket)}/objects/${key.split('/').map(seg).join('/')}`)
    },
    deleteR2: bucket => call('DELETE', `/r2/buckets/${seg(bucket)}`),
    createD1: name => call('POST', '/d1/database', { body: { name } }),
    /**
     * Creates a bucket. A 409 with code 10073 (the name was deleted a moment ago) waits until the "blocked until" time in
     * the message (plus a 2 s margin), at most 120 s from now, then retries once with a `::warning::` line. A stated time
     * beyond the cap, or a message with no readable time, throws the original error.
     */
    async createR2(name) {
      try {
        return await call('POST', '/r2/buckets', { body: { name } })
      } catch (e) {
        const hit = e instanceof CloudflareError && e.status === 409 && e.errors.find(x => x.code === R2_RECREATE_CODE)
        if (!hit) throw e
        const match = /blocked until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(String(hit.message ?? ''))
        const until = match ? Date.parse(match[1]) : NaN
        if (Number.isNaN(until)) throw new CloudflareError(`${e.message}: no readable "blocked until" time, not retrying`, { status: e.status, errors: e.errors })
        const wait = Math.max(0, until - now()) + R2_RECREATE_MARGIN_MS
        if (wait > R2_RECREATE_CAP_MS) throw new CloudflareError(`${e.message}: ${Math.round(wait / 1000)} s is over the ${R2_RECREATE_CAP_MS / 1000} s cap, not waiting`, { status: e.status, errors: e.errors })
        log(`::warning::R2 bucket ${name} was deleted a moment ago; Cloudflare blocks same-name recreation until ${match[1]}. Waiting ${Math.round(wait / 1000)} s, then retrying the create once.`)
        await sleep(wait)
        return call('POST', '/r2/buckets', { body: { name } })
      }
    },
    /** Every container application: { id, name }. (Containers API, list applications; read 2026-11-20.) */
    async containerApps() {
      const { json } = await call('GET', '/containers/applications')
      return (json.result ?? []).map(a => ({ id: a.id, name: a.name }))
    },
    deleteContainerApp: id => call('DELETE', `/containers/applications/${seg(id)}`),
    /** Every repository in the account's container registry with its tags: { name, tags }, the account prefix dropped. */
    async images() {
      const auth = await registryAuth()
      const res = await fetchImpl(new URL(`${REGISTRY}/v2/_catalog?tags=true`), { method: 'GET', headers: { authorization: auth } })
      if (!res.ok) throw new CloudflareError(`the registry catalog answered ${res.status}`, { status: res.status })
      const repos = (await res.json())?.repositories ?? {}
      const prefix = `${accountId}/`
      return Object.entries(repos).map(([repo, tags]) => ({ name: repo.replace(/^\/+/, ''), tags: Array.isArray(tags) ? tags : [] }))
        .filter(r => r.name.startsWith(prefix)).map(r => ({ name: r.name.slice(prefix.length), tags: r.tags }))
    },
    /** Deletes one image tag (its manifest), then asks the registry to collect unreferenced layers. */
    async deleteImage(name, tag) {
      if (!IMAGE_NAME.test(name ?? '') || !IMAGE_TAG.test(tag ?? '')) throw new CloudflareError(`refusing to delete image ${JSON.stringify(`${name}:${tag}`)}: not a plain name and tag`)
      const auth = await registryAuth()
      const manifest = new URL(`${REGISTRY}/v2/${accountId}/${name}/manifests/${tag}`)
      if (manifest.pathname !== `/v2/${accountId}/${name}/manifests/${tag}`) throw new CloudflareError(`refusing to delete image ${name}:${tag}: the URL resolves elsewhere`)
      const headers = { authorization: auth, accept: MANIFEST_ACCEPT }
      const head = await fetchImpl(manifest, { method: 'HEAD', headers })
      if (head.status === 404) return { deleted: false }
      if (!head.ok) throw new CloudflareError(`HEAD image ${name}:${tag} answered ${head.status}`, { status: head.status })
      const del = await fetchImpl(manifest, { method: 'DELETE', headers })
      if (!del.ok) throw new CloudflareError(`DELETE image ${name}:${tag} answered ${del.status}`, { status: del.status })
      const gc = await fetchImpl(new URL(`${REGISTRY}/v2/gc/layers`), { method: 'PUT', headers: { authorization: auth, 'content-type': 'application/json' } })
      if (!gc.ok) throw new CloudflareError(`the registry's layer collection answered ${gc.status}`, { status: gc.status })
      return { deleted: true }
    },
  }
}
