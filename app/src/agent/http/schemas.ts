// Every shared schema the HTTP client parses an answer with or builds a request body from, in one module the client loads
// with `import()` (transport.ts). The entry's first load has a size budget zod's runtime would break (see
// build-support/entry-without-zod.test.ts), so the client holds none at its top level: the chunk this file becomes loads
// beside the first reads, and the client waits for it only where it parses.
export { ErrorBodySchema } from '../../../shared/contract/common'
import { AuditPageSchema } from '../../../shared/contract/audit'
import { GrantCreateInputSchema, GrantEndInputSchema, GrantsListSchema, SupportGrantSchema } from '../../../shared/contract/grants'
import { MeSchema } from '../../../shared/contract/me'
import { InviteInputSchema, MemberRecordSchema, MemberRoleSchema, PhotoResultSchema, RoleChangeInputSchema } from '../../../shared/contract/members'
import { pageOf } from '../../../shared/contract/paging'
import { SettingRecordSchema, SettingWriteInputSchema, SettingsListSchema } from '../../../shared/contract/settings'

/** What each route answers with. */
export const ANSWERS = {
  me: MeSchema, settings: SettingsListSchema, setting: SettingRecordSchema, members: pageOf(MemberRecordSchema), member: MemberRecordSchema,
  audit: AuditPageSchema, grants: GrantsListSchema, grant: SupportGrantSchema, photo: PhotoResultSchema,
}

/** What each write sends. */
export const BODIES = {
  invite: InviteInputSchema, role: MemberRoleSchema, roleChange: RoleChangeInputSchema, grantCreate: GrantCreateInputSchema,
  grantEnd: GrantEndInputSchema, settingWrite: SettingWriteInputSchema,
}
