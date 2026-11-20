// What `me().can` lets a settings row's control do (S5, decision 0004): a control the person's role doesn't allow shows as
// read-only text, and an action only an Admin may take isn't offered. A setting follows its scope in the registry:
// brand settings need `editBrandSettings`, technical ones `editTechnical`; a person's own settings are always theirs.
import type { Can } from '../../agent/types'
import { settingRow } from '../../../shared/contract/settings-table'
import type { Row } from './content'

/** What a row's control may do. Everything when `me()` hasn't loaded (nothing shows then) or can't know. */
export function allowance(row: Row, can: Can | undefined) {
  if (!can) return { control: true, effort: true, switch: true }
  const scope = row.key ? settingRow(row.key)?.scope : undefined
  const brand = can.editBrandSettings, tech = can.editTechnical
  const byKey = row.can ? can[row.can] : scope === 'brand' ? brand : scope === 'technical' ? tech : true
  // A model's switch may be turned off by an Admin (`switchModelOff`) as well as by the Inhouse team.
  const sw = tech || can.switchModelOff
  return row.kind === 'mode' ? { control: sw, effort: tech, switch: sw } : { control: byKey, effort: byKey, switch: byKey }
}

