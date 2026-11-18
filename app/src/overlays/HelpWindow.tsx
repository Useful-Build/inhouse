// Help and guides, opened from the account menu. One guide open at a time, on the Radix accordion.
import { useAgentData, useUi } from '../state/store'
import { Accordion } from '@/components/ui/accordion'
import { Button, Guide, Window, WindowHeader } from '../ui'

export function HelpWindow() {
  const open = useUi(s => s.pop === 'help')
  const { help } = useAgentData()
  if (!open) return null
  const close = () => useUi.getState().patch({ pop: null })

  return (
    <Window onClose={close} label="Help and guides" size="md">
      <WindowHeader title="Help and guides" onClose={close} />
      <div className="flex-1 overflow-auto px-5.5 pt-1 pb-5.5">
        <Accordion type="single" collapsible className="rounded-2xl border border-border bg-card px-4">
          {help.map(g => <Guide key={g.title} title={g.title} icon={g.icon}>{g.text}</Guide>)}
        </Accordion>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="grow basis-55 text-sm text-muted-foreground">Can't find it? Your Inhouse team replies within one working day.</span>
          <Button variant="outline" size="lg" onClick={() => useUi.getState().openTeam('feedback', 'I have a question: ')}>Ask the team</Button>
        </div>
      </div>
    </Window>
  )
}
