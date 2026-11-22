// Every shared schema the HTTP client parses an answer with or builds a request body from, in one module the client loads
// with `import()` (transport.ts). The entry's first load has a size budget zod's runtime would break (see
// build-support/entry-without-zod.test.ts), so the client holds none at its top level: the chunk this file becomes loads
// beside the first reads, and the client waits for it only where it parses.
export { ErrorBodySchema } from '../../../shared/contract/common'
import { UploadResultSchema } from '../../../shared/contract/attachments'
import { ActivityPageSchema } from '../../../shared/contract/activity'
import { LibraryFilesSchema, LibraryPageSchema, LibraryWriteSchema } from '../../../shared/contract/files'
import { LibraryFileSchema } from '../../../shared/contract/library'
import { AuditPageSchema } from '../../../shared/contract/audit'
import { GrantCreateInputSchema, GrantEndInputSchema, GrantsListSchema, SupportGrantSchema } from '../../../shared/contract/grants'
import { MeSchema } from '../../../shared/contract/me'
import { InviteInputSchema, MemberRecordSchema, MemberRoleSchema, PhotoResultSchema, RoleChangeInputSchema } from '../../../shared/contract/members'
import { MemoryDataSchema, MemoryForgetInputSchema, MemoryLineSchema } from '../../../shared/contract/memory'
import { NotificationsListSchema, NotificationsReadInputSchema } from '../../../shared/contract/notifications'
import { pageOf } from '../../../shared/contract/paging'
import { SettingRecordSchema, SettingWriteInputSchema, SettingsListSchema } from '../../../shared/contract/settings'
import { UsageDataSchema } from '../../../shared/contract/usage'
import { RoutineEnabledInputSchema, RoutineRevInputSchema, RoutineRunAnswerSchema, RoutineRunInputSchema, RoutineStateSchema, RoutinesListSchema } from '../../../shared/contract/routines'
import { SkillDefSchema } from '../../../shared/contract/skill'
import { SetAsideBodySchema, TodayAnswerSchema, TodayAsideSchema } from '../../../shared/contract/today'
import { z } from 'zod'
import { ChatIdsInputSchema, ChatListSchema, ChatPageSchema, ChatPinInputSchema, ChatRenameInputSchema, ChatSummarySchema } from '../../../shared/contract/chats'
import { ModelModeSchema } from '../../../shared/contract/model'
import { CreateChatInputSchema } from '../../../shared/contract/requests'
import { ActiveRunsSchema, ChatEventSchema, PauseStateSchema, SendTurnInputSchema, SendTurnResultSchema, SocketServerMsgSchema, acceptsChatVersion } from '../../../shared/contract/runs'
import { TraceSchema } from '../../../shared/contract/trace'

/** What each route answers with. */
export const ANSWERS = {
  me: MeSchema, settings: SettingsListSchema, setting: SettingRecordSchema, members: pageOf(MemberRecordSchema), member: MemberRecordSchema,
  audit: AuditPageSchema, grants: GrantsListSchema, grant: SupportGrantSchema, photo: PhotoResultSchema, usage: UsageDataSchema,
  // P3 (W6): routes 43 to 45.
  memory: MemoryDataSchema, memoryLine: MemoryLineSchema,
  // P3 (W5): chats (routes 22 to 28 and 49), turns (29 to 33), pause (35 to 37) and the model list (38).
  chatList: ChatListSchema, chatPage: ChatPageSchema, chat: ChatSummarySchema, chatItems: z.object({ items: z.array(ChatSummarySchema) }),
  chatFile: UploadResultSchema, sendTurn: SendTurnResultSchema, ack: z.looseObject({}), activeRuns: ActiveRunsSchema, trace: TraceSchema, pause: PauseStateSchema,
  models: z.object({ default: z.string().nullable(), modes: z.array(ModelModeSchema) }),
  // P4 (W4): Activity (route 59) and the bell (route 60; route 61 answers `ack`).
  activityPage: ActivityPageSchema, notifications: NotificationsListSchema,
  // P4 (W5): the Library (rows 62, 63, 65 and 66).
  libraryPage: LibraryPageSchema, libraryFile: LibraryFileSchema, libraryFiles: LibraryFilesSchema,
  // P4 (W2): the Routines page (routes 52 to 56).
  routines: RoutinesListSchema, routineState: RoutineStateSchema, routineRun: RoutineRunAnswerSchema,
  // P4 (W3): Today (routes 57 and 58).
  today: TodayAnswerSchema, todayAside: TodayAsideSchema,
  // P6a (W3): the skills list (route 79).
  skills: z.array(SkillDefSchema),
}

/** What each write sends. */
export const BODIES = {
  invite: InviteInputSchema, role: MemberRoleSchema, roleChange: RoleChangeInputSchema, grantCreate: GrantCreateInputSchema,
  grantEnd: GrantEndInputSchema, settingWrite: SettingWriteInputSchema,
  memoryForget: MemoryForgetInputSchema,
  notificationsRead: NotificationsReadInputSchema,
  libraryWrite: LibraryWriteSchema,
  todayAside: SetAsideBodySchema,
  routineEnabled: RoutineEnabledInputSchema, routineRun: RoutineRunInputSchema, routineRev: RoutineRevInputSchema,
  createChat: CreateChatInputSchema, chatRename: ChatRenameInputSchema, chatPin: ChatPinInputSchema, chatIds: ChatIdsInputSchema, sendTurn: SendTurnInputSchema,
}

/** What the socket sends the browser and the events inside its frames; `accepts` is whether this build reads a frame's version. */
export const SOCKET = { message: SocketServerMsgSchema, event: ChatEventSchema, accepts: acceptsChatVersion }
