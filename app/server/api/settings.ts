// Routes 7 to 12 (p2-design sections 3 and 6): each scope's settings, read and written. The key resolves in the
// registry (shared/contract/settings.ts); a key of another scope, and `p:`, `photo:` and `d:support`, are 404
// `wrong_scope`, so no role, photo or grant is ever written through a setting. Personal settings are the caller's own
// (`requireObject` with the owner); an Admin's technical write passes only through the matrix's object rule.
import { SettingKeySchema, SettingWriteInputSchema, settingSpec } from '../../shared/contract/settings.ts'
import type { SettingScope, SettingValue } from '../../shared/contract/settings.ts'
import { apiError, apiJson } from '../http.ts'
import { unknownIdIn } from '../db/catalog.ts'
import { readBody, readQuery, storesOf, writer } from '../db/handler-kit.ts'
import type { ApiCtx } from '../db/handler-kit.ts'
import { BRAND_OWNER } from '../db/settings.ts'
import { z } from 'zod'

/** Keys that were settings in the demo and now have their own routes (roles, photos, grants). */
const MOVED = (key: string) => key.startsWith('p:') || key.startsWith('photo:') || key === 'd:support'

const NoQuery = z.object({}).strict()

/** The owner a scope's rows are kept under: the caller (personal) or the brand. */
const ownerFor = (c: ApiCtx, scope: SettingScope) => (scope === 'personal' ? writer(c).actorId : BRAND_OWNER)

function getSettings(scope: SettingScope) {
  return async (c: ApiCtx): Promise<Response> => {
    const query = readQuery(c.request, NoQuery)
    if ('error' in query) return query.error
    const owner = ownerFor(c, scope)
    // Personal: the caller's own, checked by the matrix's owner rule before anything is read.
    if (scope === 'personal') c.access.requireObject({ ownerId: owner })
    return apiJson({ items: await storesOf(c).settings.list(owner, scope) })
  }
}

function putSetting(scope: SettingScope) {
  return async (c: ApiCtx): Promise<Response> => {
    const key = c.params.key
    if (!SettingKeySchema.safeParse(key).success) return apiError('not_found')
    if (MOVED(key)) return apiError('not_found', { reason: 'wrong_scope' })
    const spec = settingSpec(key)
    if (!spec || unknownIdIn(key) !== null) return apiError('not_found')
    if (spec.scope !== scope) return apiError('not_found', { reason: 'wrong_scope' })

    const body = await readBody(c.request, SettingWriteInputSchema)
    if ('error' in body) return body.error
    let value: SettingValue | null = null
    if (body.ok.value !== null) {
      const parsed = spec.value.safeParse(body.ok.value)
      if (!parsed.success) return apiError('invalid')
      value = parsed.data
    } else if (key === 'g:name') {
      return apiError('invalid')
    }

    const owner = ownerFor(c, scope)
    // Before any write, never inside a try: a refusal throws to api.ts, which answers 403.
    if (scope === 'personal') c.access.requireObject({ ownerId: owner })
    if (scope === 'technical') c.access.requireObject({ settingKey: key, value })

    const done = await storesOf(c).settings.write({ owner, scope, key, value, ifRev: body.ok.ifRev }, writer(c))
    if ('ok' in done) return apiJson(done.ok)
    if ('conflict' in done) return apiError('conflict', { current: done.conflict })
    return done.refused === 'bad_approver' ? apiError('invalid') : apiError('not_found')
  }
}

/** Route 7, `GET /api/settings/personal`. */
export const getPersonalSettings = getSettings('personal')
/** Route 8, `PUT /api/settings/personal/:key` `{ value, ifRev }`. */
export const putPersonalSetting = putSetting('personal')
/** Route 9, `GET /api/settings/brand`. */
export const getBrandSettings = getSettings('brand')
/** Route 10, `PUT /api/settings/brand/:key` `{ value, ifRev }`. */
export const putBrandSetting = putSetting('brand')
/** Route 11, `GET /api/settings/technical`. */
export const getTechnicalSettings = getSettings('technical')
/** Route 12, `PUT /api/settings/technical/:key` `{ value, ifRev }`. */
export const putTechnicalSetting = putSetting('technical')
