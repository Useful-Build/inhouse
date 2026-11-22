// 3-column Bento prompt cards and an optional Routine dock for blank New chat and clear Today.
// Loaded with the page, not lazily: blank New chat centres its composer on these cards' height (ui/chat.tsx PromptBentoSlot).
import { cn } from '@/lib/utils'
import { Icon, LogoTile } from './index'

const PROMPT_META: [RegExp, string, string[]][] = [
  [/stuck|ship|fulfill|deliver/i, 'Fulfillment', ['shopify', 'shipbob']],
  [/refund|return|ticket|support|customer/i, 'Returns and CX', ['gorgias', 'shopify']],
  [/email|feature|newsletter|campaign/i, 'Merchandising', ['shopify', 'klaviyo']],
  [/meta|\b(?:ad|ads)\b|spend|roas/i, 'Paid media', ['meta-ads', 'shopify']],
  [/payout|fee|margin|revenue|invoice|amazon/i, 'Money', ['amazon', 'xero']],
]

const isRoutinePrompt = (q: string) => /^(?:Every|Each)\s+/i.test(q)

function promptMeta(question: string, available: string[]): { category: string; logos: string[] } {
  const hit = PROMPT_META.find(([re]) => re.test(question))
  if (!hit) return { category: 'Ask', logos: [] }
  return { category: hit[1], logos: hit[2].filter(k => available.includes(k)) }
}

/**
 * 3-column Bento prompt cards and an optional Routine dock for blank New chat and clear Today.
 * Each button's accessible name stays the question text (decorative category/logos are aria-hidden).
 */
export function PromptBento({ suggestions, tools, onAsk, showRoutine = true, className }: {
  suggestions: string[]; tools: string[]; onAsk: (q: string) => void; showRoutine?: boolean; className?: string
}) {
  if (!suggestions.length) return null
  const routine = suggestions.find(isRoutinePrompt)
  const cards = suggestions.filter(q => !isRoutinePrompt(q))
  return (
    <div className={cn('flex w-full flex-col gap-2.5', className)}>
      {cards.length > 0 && (
        <div className={cn('grid grid-cols-1 gap-2.5', cards.length === 2 ? 'sm:grid-cols-2' : cards.length >= 3 && 'sm:grid-cols-3')}>
          {cards.map(q => {
            const { category, logos } = promptMeta(q, tools)
            return (
              <button key={q} type="button" onClick={() => onAsk(q)}
                className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 text-left shadow-card transition hover:border-brand/35 hover:shadow-float">
                {logos.length > 0 && (
                  <span aria-hidden="true" className="flex items-center">
                    {logos.map(k => <LogoTile key={k} k={k} size="md" className="-mr-1.5 last:mr-0" />)}
                  </span>
                )}
                <span className="text-base leading-card font-medium tracking-card text-pretty text-foreground">{q}</span>
                <span aria-hidden="true" className="mt-auto flex items-center justify-between pt-1 text-xs text-muted-foreground">
                  <span>{category}</span>
                  <Icon name="arrow_forward" size={15} className="transition-colors group-hover:text-brand" />
                </span>
              </button>
            )
          })}
        </div>
      )}
      {showRoutine && routine && (
        <button type="button" onClick={() => onAsk(routine)}
          className="group flex w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3 text-left shadow-card transition hover:border-brand/35 hover:shadow-float sm:flex-nowrap">
          <span aria-hidden="true" className="inline-flex h-6 flex-none items-center gap-1.5 rounded-md bg-brand-tint px-2 text-xs font-semibold text-brand-text">
            <Icon name="event_repeat" size={14} />Routine
          </span>
          <span className="order-3 basis-full text-sm font-medium text-pretty text-foreground-2 sm:order-none sm:min-w-0 sm:flex-1 sm:basis-0">{routine}</span>
          <span aria-hidden="true" className="ml-auto inline-flex flex-none items-center gap-1 text-xs font-strong text-brand sm:ml-0">
            Try routine<Icon name="arrow_forward" size={14} />
          </span>
        </button>
      )}
    </div>
  )
}
