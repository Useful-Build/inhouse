// Settings > Always allowed (Stage 1 M2-H, N10, N15): what the Inhouse agent may do without asking, each with Remove.
// A member sees their own permissions; an admin sees everyone's, each named by whose it is. Remove shows only where the
// permission's own `can.remove` says so (display only: the server checks again) and asks first. The product only: the
// demo has no permissions, so the page isn't in its menu (menu.ts).
import { useCallback, useEffect, useState } from 'react'
import { agent } from '../../agent'
import type { AgentErrorCode, Permission } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { useCtx, useUi } from '../../state/store'
import { Button, EmptyState, SectionHeader } from '../../ui'
import { Confirm } from '../../ui/fields'
import { LoadError } from '../../ui/retry'
import { cn } from '@/lib/utils'
import { permissionDesc, removeRefusal } from './permission-words'
import { useBrandPerson } from '../../shell/asks-count'

type ListState = { status: 'loading' } | { status: 'error'; error: AgentErrorCode } | { status: 'ready'; items: Permission[] }

export function Permissions() {
  const { data } = useCtx()
  const showToast = useUi(s => s.showToast)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [asking, setAsking] = useState<Permission | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const me = agent.me()
  const nameOf = (id: string) => data.people.members.find(m => m.id === id)?.name
  // Only a brand person has permissions (route 110 refuses anyone else): the Inhouse team reads nothing here.
  const brandPerson = useBrandPerson()

  const read = useCallback(() => {
    agent.permissions().then(items => setList({ status: 'ready', items }), (e: unknown) => setList({ status: 'error', error: e instanceof AgentError ? e.code : 'unknown' }))
  }, [])
  useEffect(() => { if (brandPerson) read() }, [brandPerson, read])

  const remove = (p: Permission) => {
    setBusy(p.id)
    setRefusal(null)
    agent.removePermission(p.id, p.rev).then(items => {
      setList({ status: 'ready', items })
      showToast('Removed. Your Inhouse agent will ask first from now on.', { icon: 'check', ms: 4000 })
    }, (e: unknown) => {
      setRefusal(removeRefusal(e))
      read()
    }).finally(() => setBusy(null))
  }

  if (!brandPerson) return null
  if (list.status === 'loading') return <p role="status" className="mt-6 text-sm text-muted-foreground">Loading what your Inhouse agent may do.</p>
  if (list.status === 'error') return <LoadError what="what your Inhouse agent may do" error={list.error} onRetry={() => { setList({ status: 'loading' }); read() }} />
  return (
    <section aria-labelledby="always-allowed">
      <SectionHeader id="always-allowed" title="Done without asking" className="mt-6 mb-2.5" />
      {refusal && <p role="alert" className="m-0 mb-2.5 text-sm text-destructive-text">{refusal}</p>}
      {list.items.length === 0
        ? <EmptyState>Nothing yet. When you choose Always allow on an action, it shows here.</EmptyState>
        : (
          <ul className="m-0 list-none rounded-2xl border border-border bg-card px-5.5 py-0">
            {list.items.map((p, i) => (
              <li key={p.id} data-permission={p.id} className={cn('flex flex-wrap items-center gap-x-6 gap-y-3 py-4', i > 0 && 'border-t border-divider')}>
                <div className="min-w-0 grow basis-65">
                  <div className="text-md font-strong wrap-anywhere">{p.title}</div>
                  <div className="mt-0.5 text-sm text-pretty text-muted-foreground">{permissionDesc(p, me?.memberId, nameOf)}</div>
                </div>
                {p.can.remove && (
                  <Button variant="outline" size="lg" aria-label={`Remove: ${p.title}`} disabled={busy !== null} onClick={() => setAsking(p)}>Remove</Button>
                )}
              </li>
            ))}
          </ul>
        )}
      {asking && (
        <Confirm label="Stop allowing this?" title="Stop allowing this?" action="Remove" onCancel={() => setAsking(null)} onConfirm={() => { const p = asking; setAsking(null); remove(p) }}>
          {`${asking.title}. Your Inhouse agent will ask before it does this again.`}
        </Confirm>
      )}
    </section>
  )
}
