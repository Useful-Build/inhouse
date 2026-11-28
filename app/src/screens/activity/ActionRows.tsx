// Activity's Stage 1 M2-H rows: the actions the Inhouse agent took or proposed, with where each got to, and "Stop
// allowing this" where a permission of this person's lets the agent do it without asking. Read when the page opens.
// Nothing shows until read and only when there is an action (the demo's are its sample cards, mock-actions.ts).
//
// An action's card names its tool account, not the permission behind it, so a row offers "Stop allowing this" only
// when exactly one permission this person may remove covers that account; the question names that permission, so it
// is clear what stops. Two or more: the row points to Settings > Always allowed instead.
import { useCallback, useEffect, useState } from 'react'
import { agent } from '../../agent'
import type { ActionCard, Permission } from '../../agent/types'
import { useCtx, useUi } from '../../state/store'
import { fmtWhen } from '../../lib/format'
import { display, nowOf } from '../../state/display'
import { Button, Icon, SectionHeader } from '../../ui'
import { Confirm } from '../../ui/fields'
import { removeRefusal } from '../settings/permission-words'
import { useBrandPerson } from '../../shell/asks-count'
import { ACTION_ROWS_MAX, actionLine, stopAllowing } from './action-rows'
import { whoseCard } from '../chat/ask-card'
import type { Whose } from '../chat/ask-card'

export function ActionRows({ needle }: { needle: string }) {
  const showToast = useUi(s => s.showToast)
  const openSettings = useUi(s => s.openSettings)
  const [actions, setActions] = useState<ActionCard[] | null>(null)
  const [permissions, setPermissions] = useState<Permission[]>([])
  const { data } = useCtx()
  // Only a brand person has actions and permissions (routes 110 and 120): the Inhouse team reads nothing here.
  const brandPerson = useBrandPerson()
  const [asking, setAsking] = useState<{ permission: Permission; whose: Whose } | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const meId = agent.me()?.memberId
  const whose = (a: ActionCard) => whoseCard(a, meId, id => data.people.members.find(m => m.id === id)?.name)
  // A list that can't be read shows nothing here (the audit log has every action, and Approvals says when a read fails),
  // and says so in the console.
  const readPermissions = useCallback(() => {
    agent.permissions().then(setPermissions, (e: unknown) => { console.warn('Inhouse: could not read the permissions for Activity.', e); setPermissions([]) })
  }, [])
  useEffect(() => {
    if (!brandPerson) return
    agent.actions().then(a => setActions(a.slice(0, ACTION_ROWS_MAX)), (e: unknown) => { console.warn("Inhouse: could not read the agent's actions for Activity.", e); setActions([]) })
    readPermissions()
  }, [brandPerson, readPermissions])

  const rows = (brandPerson ? (actions ?? []) : []).filter(a => !needle || actionLine(a, whose(a)).toLowerCase().includes(needle))
  if (rows.length === 0) return null
  const now = nowOf(), d0 = display()
  const stop = (p: Permission) => {
    setRefusal(null)
    agent.removePermission(p.id, p.rev).then(items => {
      setPermissions(items)
      showToast('Removed. Your Inhouse agent will ask first from now on.', { icon: 'check', ms: 4000 })
    }, (e: unknown) => { setRefusal(removeRefusal(e)); readPermissions() })
  }
  return (
    <section aria-labelledby="activity-actions">
      <SectionHeader id="activity-actions" title="Actions" className="mt-6 mb-2.5" />
      {refusal && <p role="alert" className="m-0 mb-2.5 text-sm text-destructive-text">{refusal}</p>}
      <ul className="m-0 flex list-none flex-col gap-0.5 rounded-2xl border border-border bg-card px-2 py-1">
        {rows.map(a => {
          const offer = stopAllowing(a, permissions)
          return (
            <li key={a.id} data-activity-action={a.state} className="flex min-h-13 flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-lg py-2 pr-3 pl-3">
              <Icon name="bolt" size={19} className="flex-none text-muted-foreground" />
              <span className="min-w-0 flex-1 basis-48 text-md text-pretty wrap-anywhere">{actionLine(a, whose(a))}</span>
              <span className="flex-none text-sm whitespace-nowrap text-muted-foreground tabular-nums">{fmtWhen(a.askedAt, now, d0)}</span>
              {offer?.kind === 'one' && <Button variant="soft" size="sm" aria-label={`Stop allowing this: ${a.title}`} onClick={() => setAsking({ permission: offer.permission, whose: whose(a) })}>Stop allowing this</Button>}
              {offer?.kind === 'many' && <Button variant="soft" size="sm" aria-label={`Stop allowing this: ${a.title}`} onClick={() => openSettings('you-permissions')}>Stop allowing this</Button>}
            </li>
          )
        })}
      </ul>
      {asking && (
        <Confirm label="Stop allowing this?" title="Stop allowing this?" action="Remove" onCancel={() => setAsking(null)} onConfirm={() => { const p = asking.permission; setAsking(null); stop(p) }}>
          {asking.whose === null
            ? `${asking.permission.title}. Your Inhouse agent will ask before it does this again.`
            : `${asking.permission.title}, for ${asking.whose}. Your Inhouse agent will ask ${asking.whose} before it does this again.`}
        </Confirm>
      )}
    </section>
  )
}
