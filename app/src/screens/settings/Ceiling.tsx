// Settings > What the agent can do (Stage 1 M3-C, N26): the Inhouse ceiling. Every action the agent could take in a
// connected tool, whether it's on, its limits and who approves it, in plain words. The Inhouse team changes one
// operation at a time in a window (while editing is on in this build); an admin sees it read-only; a member never
// (route 150 refuses them, and the menu leaves the page out). The product only: the demo has no ceiling (menu.ts).
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { agent } from '../../agent'
import type { AgentErrorCode, CeilingList, CeilingRow, CeilingValues } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { CONFLICT } from '../../../shared/contract/error-codes'
import { useUi } from '../../state/store'
import { Button, SectionHeader, Switch, Window, WindowHeader } from '../../ui'
import { LoadError } from '../../ui/retry'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { approvalLine, changeRefusal, changes, fieldsOf, limitLines, lowers, readValues } from './ceiling-words'

type ListState = { status: 'loading' } | { status: 'error'; error: AgentErrorCode } | { status: 'ready'; list: CeilingList }

const valuesOf = (r: CeilingRow): CeilingValues => ({ enabled: r.enabled, perDayMax: r.perDayMax, unitsMax: r.unitsMax, bulkThreshold: r.bulkThreshold, batchMax: r.batchMax })

export function Ceiling() {
  const role = useSyncExternalStore(agent.subscribe, () => agent.me()?.role ?? null)
  // Route 150 lets the Inhouse team and admins read; a member reads nothing here.
  const reads = role === 'admin' || role === 'inhouse'
  const [state, setState] = useState<ListState>({ status: 'loading' })
  const [editing, setEditing] = useState<CeilingRow | null>(null)

  const read = useCallback(() => {
    agent.ceiling().then(list => setState({ status: 'ready', list }), (e: unknown) => setState({ status: 'error', error: e instanceof AgentError ? e.code : 'unknown' }))
  }, [])
  useEffect(() => { if (reads) read() }, [reads, read])

  /** The row as the server has it now, in the list (and in the window, when it's that row's). */
  const put = (row: CeilingRow) => setState(s => (s.status === 'ready' ? { status: 'ready', list: { ...s.list, items: s.list.items.map(i => (i.operation === row.operation ? row : i)) } } : s))

  // A member has no menu entry for this page; a link to it says why it's empty. Before `me()` answers, nothing.
  if (role === 'member') return <p role="note" className="mt-6 text-sm text-foreground-3">Only admins and the Inhouse team can see this.</p>
  if (!reads) return null
  if (state.status === 'loading') return <p role="status" className="mt-6 text-sm text-muted-foreground">Loading what your Inhouse agent can do.</p>
  if (state.status === 'error') return <LoadError what="what your Inhouse agent can do" error={state.error} onRetry={() => { setState({ status: 'loading' }); read() }} />
  const { list } = state
  const note = role === 'admin' ? 'The Inhouse team sets these.' : list.writesOff ? 'Changes are switched off in this build. This is what is set now.' : null
  return (
    <section aria-labelledby="ceiling-actions">
      <SectionHeader id="ceiling-actions" title="Actions in your tools" className="mt-6 mb-2.5" />
      {note && <p role="note" className="m-0 mb-2.5 text-sm text-foreground-3">{note}</p>}
      {/* Read-only (an admin, or editing off), the list has no button, and on a long page the content scrolls: the list
          itself takes focus so a keyboard can reach and scroll it (axe scrollable-region-focusable). */}
      <ul aria-labelledby="ceiling-actions" tabIndex={list.can.edit ? undefined : 0} className="m-0 list-none rounded-2xl border border-border bg-card px-5.5 py-0">
        {list.items.map((r, i) => (
          <li key={r.operation} data-ceiling={r.operation} className={cn('flex flex-wrap items-start gap-x-6 gap-y-3 py-4', i > 0 && 'border-t border-divider')}>
            <div className="min-w-0 grow basis-65">
              <div className="text-md font-strong wrap-anywhere">{r.title}</div>
              <div className="mt-0.5 text-sm text-pretty text-muted-foreground">{`${r.tool} · ${r.enabled ? 'On' : 'Off'}`}</div>
              <p className="mt-1.5 mb-0 text-sm text-pretty text-foreground-2">{r.description}</p>
              <ul className="mt-1.5 mb-0 list-none p-0 text-sm text-pretty text-foreground-2">
                {limitLines(r).map(l => <li key={l}>{l}</li>)}
              </ul>
              <p className="mt-1.5 mb-0 text-sm text-pretty text-foreground-3">{approvalLine(r)}</p>
            </div>
            {list.can.edit && <Button variant="outline" size="lg" aria-label={`Change: ${r.title}`} onClick={() => setEditing(r)}>Change</Button>}
          </li>
        ))}
      </ul>
      {editing && (
        <ChangeWindow key={`${editing.operation}|${editing.rev}`} row={editing} onClose={() => setEditing(null)}
          onSaved={row => { put(row); setEditing(null) }} onCurrent={row => { put(row); setEditing(row) }} />
      )}
    </section>
  )
}

/** One operation's switch and limits. A stale save shows the row as it is now (`onCurrent`), keeping the window open. */
function ChangeWindow({ row, onClose, onSaved, onCurrent }: { row: CeilingRow; onClose: () => void; onSaved: (row: CeilingRow) => void; onCurrent: (row: CeilingRow) => void }) {
  const showToast = useUi(s => s.showToast)
  const [enabled, setEnabled] = useState(row.enabled)
  const [typed, setTyped] = useState<Partial<Record<keyof CeilingValues, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The window leaves Escape to the screens, so it listens for it here.
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const prev = valuesOf(row)
  const next = readValues(row, enabled, typed)
  const changed = 'ok' in next && changes(prev, next.ok)
  const save = () => {
    if ('error' in next) return setError(next.error)
    if (!changed) return onClose()
    setError(null); setBusy(true)
    agent.setCeiling(row.operation, { ...next.ok, ifRev: row.rev }).then(saved => {
      showToast(`Saved. ${saved.title} is ${saved.enabled ? 'on' : 'off'}.`, { icon: 'check', ms: 4000 })
      onSaved(saved)
    }, (e: unknown) => {
      setBusy(false)
      // A stale change: the window shows the row as it is now (a new window, so nothing typed is kept against it).
      const current = e instanceof AgentError && e.code === CONFLICT && e.current ? (e.current as unknown as CeilingRow) : null
      if (current) {
        showToast(changeRefusal(e), { icon: 'info', ms: 5000 })
        return onCurrent(current)
      }
      setError(changeRefusal(e))
    })
  }

  return (
    <Window onClose={onClose} label={`Change: ${row.title}`} size="sm" initialFocus="[role=switch]">
      <WindowHeader title={row.title} description={row.tool} onClose={onClose} />
      <form className="flex flex-col gap-3.5 px-5.5 pt-3 pb-5.5" onSubmit={e => { e.preventDefault(); save() }}>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-strong text-foreground-2">Let your Inhouse agent do this</span>
          <Switch on={enabled} label="Let your Inhouse agent do this" onChange={() => { setEnabled(v => !v); setError(null) }} />
        </div>
        {fieldsOf(row).map(f => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <Label htmlFor={`ceiling-${f.key}`} className="text-sm font-strong text-foreground-2">{f.label}</Label>
            <Input id={`ceiling-${f.key}`} inputMode="numeric" autoComplete="off" spellCheck={false} value={typed[f.key] ?? f.shown(row[f.key])}
              onChange={e => { setTyped(t => ({ ...t, [f.key]: e.target.value })); setError(null) }}
              className="box-border h-9.5 rounded-lg bg-card px-3.25 text-base shadow-none md:text-base" />
          </div>
        ))}
        {'ok' in next && lowers(prev, next.ok) && (
          <p role="note" className="m-0 text-sm text-foreground-3">Lowering a limit or switching this off ends every Always allow for it. People are asked again.</p>
        )}
        {error && <p role="alert" className="m-0 text-sm text-destructive-text">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" size="lg" onClick={onClose}>Cancel</Button>
          <Button size="lg" type="submit" disabled={busy || ('ok' in next && !changed)}>Save changes</Button>
        </div>
      </form>
    </Window>
  )
}
