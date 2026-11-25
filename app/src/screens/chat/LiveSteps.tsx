// Live working steps while an answer streams: rows build up as `step` events arrive, with the latest running step
// highlighted via Trace's shimmer utility and earlier ones shown as done. Hidden from the live log: Chats.tsx announces
// `thinkingText` through an sr-only status region so screen readers hear one update per step.
import { readingTools } from '../../state/derive'
import { useCtx } from '../../state/store'
import { AgentMark, Icon, LogoTile } from '../../ui'
import { Trace, TraceLine, TraceTitle } from '../../ui/agent'
import { mapLiveStepsToTraceRows, type TraceLiveOutcome, type TraceRow } from './step-data'
import type { LiveStep } from './view'

function LiveStepList({ rows }: { rows: readonly TraceRow[] }) {
  return (
    <Trace className="gap-1.5">
      {rows.map(r => (
        <div key={r.id} className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            {r.status === 'running'
              ? <AgentMark live />
              : (
                <span aria-hidden="true" className="flex size-6 flex-none items-center justify-center text-muted-foreground">
                  <Icon name={r.icon} size={15} className={r.status === 'error' ? 'text-destructive' : undefined} />
                </span>
              )}
            <TraceLine status={r.status === 'done' ? undefined : r.status} className="text-base">
              {r.tool !== null && <LogoTile k={r.tool} size="sm" round />}
              <TraceTitle>{r.title}</TraceTitle>
            </TraceLine>
          </div>
          {r.children.length > 0 && (
            <div className="mt-1.5 ml-3 border-l border-border pl-4">
              <LiveStepList rows={r.children} />
            </div>
          )}
        </div>
      ))}
    </Trace>
  )
}

export function LiveSteps({ steps, fallback, outcome = 'running' }: {
  steps?: readonly LiveStep[]
  fallback: string
  outcome?: TraceLiveOutcome
}) {
  const ctx = useCtx()
  const keys = readingTools(ctx)
  const input = steps && steps.length > 0
    ? steps
    : fallback
      ? [{ id: 'thinking', label: fallback }]
      : []
  const rows = mapLiveStepsToTraceRows(ctx.data, input, { outcome, keys })
  return (
    <div data-thinking aria-hidden="true" className="flex min-w-0 flex-col">
      {rows.length > 0 ? <LiveStepList rows={rows} /> : <AgentMark live />}
    </div>
  )
}
