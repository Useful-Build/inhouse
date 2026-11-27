// The one question before a change that gives something rather than taking it away (Stage 1 M3-C, N27: marking a
// channel for alerts gives the agent a standing permission). `Confirm` (ui/fields.tsx) with its action drawn as a
// normal one, not in the destructive colour (DESIGN.md). Its own file, in the Settings chunk: ui/fields.tsx loads with
// Today, under its size budget.
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, Window } from '../../ui'

export function GiveQuestion({ title, children, action, onCancel, onConfirm }: { title: string; children: ReactNode; action: string; onCancel: () => void; onConfirm: () => void }) {
  // The window leaves Escape to the screens, so the question listens for it here, once for its life (as Confirm does).
  const cancel = useRef(onCancel)
  useEffect(() => { cancel.current = onCancel })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <Window onClose={onCancel} label={title} size="sm" layer="confirm" initialFocus="[data-cancel]">
      <div className="px-5.5 pt-5.5 pb-5">
        <h2 className="text-xl font-semibold tracking-stat">{title}</h2>
        <p className="mt-2 mb-0 text-base leading-prose text-foreground-3">{children}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" size="lg" data-cancel onClick={onCancel}>Cancel</Button>
          <Button size="lg" onClick={onConfirm}>{action}</Button>
        </div>
      </div>
    </Window>
  )
}
