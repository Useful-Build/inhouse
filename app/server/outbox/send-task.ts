// The send task's name (N11): `outbox-send:<actionId>`, one per approved action, run by BrandAgent's scheduler. Its own
// module so the routes that ask for it (an answer's `poke`) needn't import the dispatcher.
export const SEND_KIND = 'outbox-send'
export const sendTaskId = (actionId: string): string => `${SEND_KIND}:${actionId}`
