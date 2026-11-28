// The demo agent's long jobs (J1 to J6): loaded lazily with the first job read or long-task run, so none of its sample
// data sits on Today's first load (scripts/check-bundle.mjs). Avoids importing zod so CSP and bundle size stay clean.
import rawJobs from '@sample/jobs.json'
import type { Job, JobOutcome } from '../../shared/contract/jobs'
import type { AgentNotification, Instant, MessagePart, StoredMessage } from './types'
import { instantOf } from '../lib/format'
import { AgentError } from './types'
import { NOT_FOUND } from '../../shared/contract/error-codes'

export const JOB_CARRIED_ON = 'Your Inhouse agent carried on with this task by itself.'

export interface JobsHost {
  now: () => number
  shown: () => boolean
  at: (sampleTime: string) => Instant
  onChanged: () => void
}

interface RawSeedJob {
  jobId: string
  chatId: string
  rootTurnId: string
  state: 'running' | 'waiting' | 'ended'
  outcome: JobOutcome | null
  startedAt: string
  deadlineAt: string
  endedAt: string | null
  progress: { label: string; helpers: number } | null
  cost: { minor: number; currency: string } | null
}

interface RawSeedMsg {
  id: string
  role: 'user' | 'event' | 'agent'
  text?: string
  part?: MessagePart
  trace?: string
  model?: string
  at: string
  turnId: string
  runId: string
}

interface RawChatEntry {
  job: RawSeedJob | null
  messages: RawSeedMsg[]
  followUpReply?: { match: string; text: string; trace: string }
}

const CHATS = rawJobs.chats as unknown as Record<string, RawChatEntry>

const JOB_FINISH_TITLE = 'A long job finished'
const JOB_STOP_TITLE = 'A long job stopped'
const JOB_STOPPED_BELL: Record<Exclude<JobOutcome, 'done'>, string> = {
  budget: 'It reached the most a job may spend. An admin can raise the job budget in Settings, then ask again.',
  time: 'It reached the 8-hour limit for one job.',
  stuck: 'It stopped making progress, so it was stopped.',
  failed: 'Something went wrong, so it stopped. You can ask again in the chat.',
  cancelled: 'It was stopped before it finished.',
  taken_over: 'A new message in the chat took over.',
}

const cloneJob = (raw: RawSeedJob, at: (s: string) => Instant): Job => ({
  jobId: raw.jobId,
  chatId: raw.chatId,
  rootTurnId: raw.rootTurnId,
  state: raw.state,
  outcome: raw.outcome,
  startedAt: at(raw.startedAt),
  deadlineAt: at(raw.deadlineAt),
  endedAt: raw.endedAt === null ? null : at(raw.endedAt),
  progress: raw.progress ? { ...raw.progress } : null,
  cost: raw.cost ? { ...raw.cost } : null,
})

/** True when a typed prompt asks for a multi-step research or full-catalog task that carries on as a long job. */
export const isLongTaskRequest = (q: string): boolean =>
  /\b(long job|full catalog|deep (?:research|audit|analysis)|audit (?:all|every)|across every sku)\b/i.test(q)

/** True when a chat id comes with lazily loaded messages in jobs.json. */
export const hasSeededJobMessages = (chatId: string): boolean => Object.hasOwn(CHATS, chatId)

export class MockJobs {
  private readonly h: JobsHost
  private seeded = new Map<string, Job>()
  private live = new Map<string, Job>()
  private abortByJob = new Map<string, AbortController>()
  private notices: AgentNotification[] = []
  private idSeq = 0

  constructor(h: JobsHost) {
    this.h = h
    this.seedInitial()
  }

  private seedInitial() {
    this.seeded.clear()
    for (const [chatId, entry] of Object.entries(CHATS)) {
      if (entry.job) this.seeded.set(chatId, cloneJob(entry.job, this.h.at))
    }
  }

  reset() {
    for (const ac of this.abortByJob.values()) ac.abort()
    this.abortByJob.clear()
    this.live.clear()
    this.notices = []
    this.seedInitial()
  }

  private currentForChat(chatId: string): Job | null {
    if (!this.h.shown()) return null
    return this.live.get(chatId) ?? this.seeded.get(chatId) ?? null
  }

  job(chatId: string): Job | null {
    const j = this.currentForChat(chatId)
    return j ? { ...j, ...(j.progress ? { progress: { ...j.progress } } : {}), ...(j.cost ? { cost: { ...j.cost } } : {}) } : null
  }

  /** Seeded messages (including carry-on event notes) for chats whose `turns` in chats.json are []. */
  messages(chatId: string): StoredMessage[] {
    if (!this.h.shown() || !Object.hasOwn(CHATS, chatId)) return []
    const entry = CHATS[chatId]!
    return entry.messages.map((m, pos): StoredMessage => {
      const at = this.h.at(m.at)
      if (m.role === 'user') {
        return { id: m.id, role: 'user', text: m.text!, turnId: m.turnId, runId: m.runId, pos, at }
      }
      if (m.role === 'event') {
        return { id: m.id, role: 'event', text: m.text!, turnId: m.turnId, runId: m.runId, pos, at }
      }
      return {
        id: m.id, role: 'agent', part: m.part!, trace: m.trace!, model: m.model!, turnId: m.turnId, runId: m.runId, pos, at,
      }
    })
  }

  /** Answer when the user repeats or asks a follow-up in one of the lazy job chats, or null if off-script. */
  seededReply(chatId: string, q: string): { text: string; trace: string } | null {
    if (!this.h.shown() || !Object.hasOwn(CHATS, chatId)) return null
    const entry = CHATS[chatId]!
    const follow = entry.followUpReply
    if (follow && new RegExp(follow.match, 'i').test(q)) return { text: follow.text, trace: follow.trace }
    // If Regenerate replays the first user turn in this lazy chat, return its seeded opening agent part.
    const firstUser = entry.messages.find(m => m.role === 'user')
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.?!]+$/, '')
    if (firstUser?.text && norm(firstUser.text) === norm(q)) {
      const firstAgent = entry.messages.find(m => m.role === 'agent' && m.part?.type === 'text')
      if (firstAgent?.part?.type === 'text' && firstAgent.trace) return { text: firstAgent.part.text, trace: firstAgent.trace }
    }
    return null
  }

  notifications(): AgentNotification[] {
    return this.h.shown() ? this.notices : []
  }

  nextJobId(): string {
    return `j_${`demoJob${(++this.idSeq).toString(36).padStart(6, '0')}`.padEnd(22, '0').slice(0, 22)}`
  }

  startJob(chatId: string, rootTurnId: string, label: string, helpers = 2): { job: Job; controller: AbortController } {
    const startMs = this.h.now()
    const job: Job = {
      jobId: this.nextJobId(),
      chatId,
      rootTurnId,
      state: 'running',
      outcome: null,
      startedAt: instantOf(startMs),
      deadlineAt: instantOf(startMs + 8 * 3_600_000),
      endedAt: null,
      progress: { label, helpers },
      cost: { minor: 12, currency: 'USD' },
    }
    const controller = new AbortController()
    this.live.set(chatId, job)
    this.abortByJob.set(job.jobId, controller)
    this.h.onChanged()
    return { job, controller }
  }

  updateProgress(chatId: string, jobId: string, label: string, helpers: number): Job | null {
    const cur = this.currentForChat(chatId)
    if (!cur || cur.jobId !== jobId || cur.state === 'ended') return null
    const updated: Job = { ...cur, progress: { label, helpers } }
    if (this.live.has(chatId)) this.live.set(chatId, updated)
    else this.seeded.set(chatId, updated)
    return updated
  }

  endJob(chatId: string, jobId: string, outcome: JobOutcome, costMinor = 140): Job | null {
    const cur = this.currentForChat(chatId)
    if (!cur || cur.jobId !== jobId || cur.state === 'ended') return null
    const endedAt = instantOf(this.h.now())
    const updated: Job = {
      ...cur,
      state: 'ended',
      outcome,
      endedAt,
      progress: null,
      cost: { minor: costMinor, currency: 'USD' },
    }
    if (this.live.has(chatId)) this.live.set(chatId, updated)
    else this.seeded.set(chatId, updated)
    this.abortByJob.delete(jobId)
    this.recordNotice(updated)
    this.h.onChanged()
    return updated
  }

  cancelJob(jobId: string): Job {
    if (!this.h.shown()) throw new AgentError(NOT_FOUND, "That job isn't here.")
    const hit = [...this.live.entries(), ...this.seeded.entries()].find(([, j]) => j.jobId === jobId)
    if (!hit) throw new AgentError(NOT_FOUND, "That job isn't here.")
    const [chatId, cur] = hit
    if (cur.state === 'ended') return this.job(chatId)!
    this.abortByJob.get(jobId)?.abort()
    return this.endJob(chatId, jobId, 'cancelled', cur.cost?.minor ?? 120)!
  }

  private recordNotice(job: Job) {
    if (!job.outcome || !job.endedAt) return
    const id = `job_${job.jobId}`
    if (this.notices.some(n => n.id === id)) return
    const outcome = job.outcome
    const done = outcome === 'done'
    this.notices = [
      {
        id,
        icon: done ? 'check_circle' : 'error',
        text: outcome === 'done' ? JOB_FINISH_TITLE : `${JOB_STOP_TITLE}. ${JOB_STOPPED_BELL[outcome]}`,
        who: 'Your Inhouse agent',
        at: job.endedAt,
        unread: true,
        link: { to: 'chat', id: job.chatId },
      },
      ...this.notices,
    ]
  }
}
