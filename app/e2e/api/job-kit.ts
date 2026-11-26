import { expect, type APIRequestContext } from '@playwright/test'
import { createChat, send } from './chat-kit.ts'
import { actor, call, type Actor } from './kit.ts'

/** Seed the scripted job with a turn that saves a file and a checkpoint. */
export async function startJob(request: APIRequestContext, who: Actor, text = 'scenario:long-job Seed the job.') {
  const chatId = await createChat(request, who)
  return { chatId, ...(await send(request, who, chatId, text)) }
}

export async function jobControl(request: APIRequestContext, json: object): Promise<unknown> {
  const r = await call(request, actor('release'), 'POST', '/api/ops/alarm', { json })
  expect(r.status, r.text).toBe(200)
  return r.json as unknown
}

/** Replace the overrides. Pass {} in teardown to clear them. */
export async function setJobTimings(request: APIRequestContext, overrides: Record<string, number>): Promise<void> {
  expect(await jobControl(request, { action: 'setTimings', overrides })).toEqual({ set: true })
}

export async function killRunner(request: APIRequestContext, runner: string): Promise<void> {
  expect(await jobControl(request, { action: 'killRunner', runner })).toEqual({ killed: true })
}

/** N3's job state route. Call once M1-B's route is present. */
export async function readJob(request: APIRequestContext, who: Actor, chatId: string): Promise<unknown> {
  const r = await call(request, who, 'GET', `/api/chats/${chatId}/job`)
  expect(r.status, r.text).toBe(200)
  return r.json as unknown
}
