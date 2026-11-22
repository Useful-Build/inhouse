// The read-side runner's command line, parsed and refused in one place (run.mjs only wires it). Pure, so a test drives every refusal.
import { READ_SIDE_CASES, PAGE_HOST } from './cases.ts'
import type { ReadSideCase } from './cases.ts'

/** The picker models' API ids (server/model/catalog.ts, pinned by a test). One dispatch runs exactly one. */
export const MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const
/** Pinned for every model, no override and no fallback. */
export const EFFORT = 'medium'
/** A dispatch's budget may not exceed the eval brand's Spending cap (STORE_DATA_CAP, EVAL_CAP; a test pins them equal). */
export const READ_SIDE_CAP_USD = 50

export interface ReadSideArgs {
  target: 'fake' | 'product'
  model: string
  out: string
  pageOrigin: string | null
  paid: boolean
  budgetUsd: number | null
  /** Fake target only: which fake agent answers. */
  agent: 'honest' | 'obedient'
  sha: string | null
  /** Debug: the run is partial and never passes. */
  cases: readonly ReadSideCase[]
  partial: boolean
}

export class Refused extends Error {}

export interface RawArgs {
  target?: string; model?: string; out?: string; 'page-origin'?: string; paid?: boolean; budget?: string; agent?: string; sha?: string; cases?: string; effort?: string
}

/** An https origin with nothing after it: `https://host` or `https://host:port`. */
export function pageOriginOf(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Refused(`--page-origin ${JSON.stringify(raw)} is not a URL`)
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash || raw.replace(/\/$/, '') !== u.origin) {
    throw new Refused(`--page-origin must be an https origin like https://host, got ${JSON.stringify(raw)}`)
  }
  return u.origin
}

/** Points the web page cases at the real page host: prompts, allowed URLs and hosts. Other cases are untouched. */
export function withPageOrigin(cases: readonly ReadSideCase[], origin: string): ReadSideCase[] {
  const host = new URL(origin).host
  const swap = (s: string) => s.split(`https://${PAGE_HOST}`).join(origin)
  return cases.map(c => c.source !== 'web_page' ? c : {
    ...c,
    hosts: c.hosts.map(h => (h === PAGE_HOST ? host : h)),
    allowedUrls: c.allowedUrls.map(swap),
    chats: c.chats.map(t => ({ ...t, prompt: swap(t.prompt) })),
  })
}

export function parseReadSideArgs(a: RawArgs): ReadSideArgs {
  if (a.target !== 'fake' && a.target !== 'product') throw new Refused('--target must be fake or product')
  if (!a.out) throw new Refused('--out <dir> is required')
  if (a.effort !== undefined && a.effort !== EFFORT) throw new Refused(`effort is pinned to ${EFFORT} for every model: --effort ${a.effort} is refused`)
  const model = a.model ?? (a.target === 'fake' ? 'fake' : undefined)
  if (!model) throw new Refused('--model <api id> is required: one model per dispatch')
  if (model.includes(',')) throw new Refused('one model per dispatch: pass a single --model')
  if (a.target === 'product' && !(MODELS as readonly string[]).includes(model)) throw new Refused(`--model ${model} is not a picker model (${MODELS.join(', ')})`)
  const budget = a.budget === undefined ? null : Number(a.budget)
  if (budget !== null && !(Number.isFinite(budget) && budget > 0)) throw new Refused('--budget must be a positive number of USD')
  if (a.target === 'product') {
    if (!a.paid || budget === null) throw new Refused('the product target refuses without --paid and --budget <usd> (the dispatch\'s approved max_usd)')
    if (budget > READ_SIDE_CAP_USD) throw new Refused(`--budget $${budget} is over the dispatch cap $${READ_SIDE_CAP_USD}`)
  } else if (a.paid || budget !== null) {
    throw new Refused('--paid and --budget are for the product target only: the fake target costs nothing')
  }
  const agent = a.agent ?? 'honest'
  if (agent !== 'honest' && agent !== 'obedient') throw new Refused('--agent must be honest or obedient')
  if (a.target === 'product' && a.agent !== undefined) throw new Refused('--agent is for the fake target only')
  let cases: ReadSideCase[] = [...READ_SIDE_CASES]
  const wanted = a.cases ? a.cases.split(',') : null
  if (wanted) {
    const unknown = wanted.filter(id => !cases.some(c => c.id === id))
    if (unknown.length > 0) throw new Refused(`unknown case in --cases: ${unknown.join(',')}`)
    cases = cases.filter(c => wanted.includes(c.id))
  }
  const pageOrigin = a['page-origin'] === undefined ? null : pageOriginOf(a['page-origin'])
  if (a.target === 'product' && pageOrigin === null && cases.some(c => c.source === 'web_page')) {
    throw new Refused('--page-origin <https origin> is required: web page cases need the eval page host (no default)')
  }
  if (pageOrigin) cases = withPageOrigin(cases, pageOrigin)
  return { target: a.target, model, out: a.out, pageOrigin, paid: a.paid ?? false, budgetUsd: budget, agent, sha: a.sha ?? null, cases, partial: wanted !== null }
}
