// The ids of P3's chats, runs and turns (p3-design section 0), in one file so runs.ts and chats.ts can both use them
// without importing each other (a cycle would read a schema before it's defined). Not exported from index.ts by
// itself: chats.ts exports `ChatIdSchema`, runs.ts the run, turn, message, step and file ids.
import { z } from 'zod'

/** A chat id: the client makes it, so it's the runner protocol's `Id` rule (`RunStart.chatId`). */
export const ChatIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
export type ChatId = z.infer<typeof ChatIdSchema>

/** 128 random bits as base64url without padding: 22 characters. */
const RANDOM = '[A-Za-z0-9_-]{22}'

/** A run (one answer in one chat): `r_` + 128 random bits. */
export const RunIdSchema = z.string().regex(new RegExp(`^r_${RANDOM}$`))
export type RunId = z.infer<typeof RunIdSchema>
/** A turn (one message the agent answers, one runner run): `t_` + 128 random bits. */
export const TurnIdSchema = z.string().regex(new RegExp(`^t_${RANDOM}$`))
export type TurnId = z.infer<typeof TurnIdSchema>
/** A message: the user's `<turnId>.u`, an agent part `<turnId>.<n>`. Stable across the live stream, the replay and D1. */
export const MessageIdSchema = z.string().regex(new RegExp(`^t_${RANDOM}\\.(u|0|[1-9]\\d{0,5})$`))
/** A step (a tool call shown as a work row): `<turnId>.s<n>`. */
export const StepIdSchema = z.string().regex(new RegExp(`^t_${RANDOM}\\.s(0|[1-9]\\d{0,5})$`))
/** A chat file (an attachment or an output): `f_` + 128 random bits. */
export const FileIdSchema = z.string().regex(new RegExp(`^f_${RANDOM}$`))
