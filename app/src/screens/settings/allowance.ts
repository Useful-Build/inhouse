// What `me().can` lets a settings row's control do (S5, decision 0004): a control the person's role doesn't allow shows as
// read-only text, and an action only an Admin may take isn't offered. A setting follows its scope in the registry:
// brand settings need `editBrandSettings`, technical ones `editTechnical`; a person's own settings (and photo) are theirs,
// except for the Inhouse team, whom the server refuses them (access-matrix rows 8, 13 and 14 are member and admin only).
import type { Can, ResourceKey, Role } from '../../agent/types'
import { settingRow } from '../../../shared/contract/settings-table'
import type { Row } from './content'

/**
 * What a row's control may do. With no `me()` yet, the demo allows everything (its Loading scenario) and the product allows
 * nothing (`failClosed`): a control must never show for a person whose role isn't known.
 */
export function allowance(row: Row, can: Can | undefined, failClosed = false, role?: Role) {
  if (!can) return failClosed ? { control: false, effort: false, switch: false } : { control: true, effort: true, switch: true }
  const scope = row.key ? settingRow(row.key)?.scope : undefined
  const brand = can.editBrandSettings, tech = can.editTechnical
  const own = role !== 'inhouse'
  const byKey = row.can ? can[row.can] : row.kind === 'photo' || scope === 'personal' ? own : scope === 'brand' ? brand : scope === 'technical' ? tech : true
  // Without `editTechnical` an Admin may still turn a model off and back on (`switchModel`, decision 27a).
  const sw = tech || can.switchModel
  // A model row shows the switch to anyone who may use it, and the effort picker only to those who may edit.
  return row.kind === 'mode' ? { control: sw, effort: tech, switch: sw } : { control: byKey, effort: byKey, switch: byKey }
}

/** P5 W4: whether this person may change the Slack notice channels (route 75): the `editBrandSettings` key, never a role name. */
export const mayEditNotify = (can: Can | undefined): boolean => !!can?.editBrandSettings


/** Whether a row's Remove button shows: the key the row names (a channel: `editBrandSettings`), else a member's removal. */
export const showsRemove = (row: Row, can: Can | undefined): boolean => !!row.remove && can?.[row.remove.can ?? 'remove'] !== false

/** The lists a settings page reads, so a failed read says what couldn't load. `grants` is read only by whoever sees the grant (route 16 is Admin and Inhouse only). */
export function pageResources(tab: string, showGrant: boolean): ResourceKey[] {
  switch (tab) {
    case 'team-members': return ['members']
    case 'team-audit': return ['audit']
    case 'team-data': return showGrant ? ['grants', 'members'] : ['members']
    case 'you-memory': case 'team-memory': return ['memory']
    default: return []
  }
}
