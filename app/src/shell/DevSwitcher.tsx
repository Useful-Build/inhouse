// Demo switches. Dev builds, or any build opened with ?demo.
import { demo } from '../agent'
import type { Ambient } from '../state/store'
import { useUi } from '../state/store'
import { Button, Icon, IconButton, Segmented, Switch } from '../ui'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { demoEnabled } from './demo'


/** The dashed circle that opens the switches. It sits in the top bar, so it never covers a page's controls. */
export function DemoButton() {
  const open = useUi(s => s.demoOpen)
  const scenario = useUi(s => s.scenario)
  const patch = useUi(s => s.patch)
  if (!demoEnabled()) return null
  // While the panel is open its own close button is the control; keep the slot so the bar doesn't shift.
  if (open) return <span aria-hidden="true" className="size-7.5 flex-none" />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={() => patch({ demoOpen: true })} aria-label={`Demo switches: ${scenario}`}
          className="flex size-7.5 flex-none items-center justify-center rounded-full border border-dashed border-border-strong bg-card/85 text-foreground-3">
          <Icon name="tune" size={15} />
        </button>
      </TooltipTrigger>
      <TooltipContent>Demo switches · {scenario}</TooltipContent>
    </Tooltip>
  )
}

export function DevSwitcher() {
  const open = useUi(s => s.demoOpen)
  const scenario = useUi(s => s.scenario)
  const ambient = useUi(s => s.ambient)
  const animateMark = useUi(s => s.animateMark)
  const viewAs = useUi(s => s.viewAs)
  const { setDemo, resetDemo, showToast, patch } = useUi.getState()
  if (!demoEnabled() || !open) return null
  const label = 'mt-2.5 mb-1 text-2xs font-strong text-muted-foreground'
  return (
    <div role="dialog" aria-label="Demo switches" className="fixed top-16 right-3 z-dev box-border w-75 max-w-screen-gutter-sm rounded-2xl border border-dashed border-border-strong bg-popover p-3 shadow-menu">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-sm font-semibold">Demo switches</span>
        <span className="text-2xs text-muted-foreground">Dev only</span>
        <IconButton icon="close" label="Close demo switches" size={18} box="icon-sm" onClick={() => patch({ demoOpen: false })} />
      </div>
      <div className={label}>Scenario</div>
      <div className="flex flex-wrap gap-1">
        {(demo?.scenarios ?? []).map(s => (
          <Button key={s} variant={scenario === s ? 'primary' : 'soft'} size="sm" aria-pressed={scenario === s} onClick={() => setDemo({ scenario: s })}>{s}</Button>
        ))}
      </div>
      <div className={label}>View as</div>
      <Segmented<'admin' | 'member'> label="View as" value={viewAs} options={[['admin', 'Admin'], ['member', 'Member']]} onChange={v => setDemo({ viewAs: v })} />
      <div className={label}>Dot sweep</div>
      <Segmented<Ambient> label="Dot sweep" value={ambient} options={[['Always', 'Always'], ['When Inhouse agent works', 'When working'], ['Off', 'Off']]} onChange={v => setDemo({ ambient: v })} />
      <div className="mt-3 flex items-center gap-2.5 text-sm">
        <span className="flex-1">Animate the agent's mark</span>
        <Switch small on={animateMark} label="Animate the agent's mark" onChange={() => setDemo({ animateMark: !animateMark })} />
      </div>
      <Button variant="secondary" className="mt-3 w-full"
        onClick={() => { resetDemo(); showToast('Demo reset. Every change is cleared.', { ms: 4000 }) }}>
        <Icon name="restart_alt" size={16} />Reset demo
      </Button>
    </div>
  )
}
