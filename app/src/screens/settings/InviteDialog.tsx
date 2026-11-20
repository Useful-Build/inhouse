// Invite someone: name, work email, title and role. Saved through `inviteMember`; a refusal shows here and keeps what was typed.
import { useEffect, useRef, useState } from 'react'
import { agent } from '../../agent'
import { AgentError } from '../../agent/types'
import type { MemberRole } from '../../agent/types'
import { useUi } from '../../state/store'
import { Button, Window, WindowHeader } from '../../ui'
import { Select } from '../../ui/fields'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { checkField } from './content'

const ROLES: [string, MemberRole][] = [['Member', 'member'], ['Admin', 'admin']]

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [role, setRole] = useState('Member')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const showToast = useUi(s => s.showToast)
  // The window leaves Escape to the screens, so the dialog listens for it here.
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const send = async () => {
    const who = name.trim()
    const mail = checkField('email', email)
    if (!who) return setError('Enter their name.')
    if ('error' in mail) return setError(mail.error)
    setError(null); setBusy(true)
    try {
      await agent.inviteMember({ name: who, email: mail.value, ...(title.trim() ? { title: title.trim() } : {}), role: ROLES.find(([l]) => l === role)![1] })
      showToast(`Invited ${who}. They sign in with their work email.`)
      onClose()
    } catch (e) {
      // The agent's own notice already told the person why; the window keeps what was typed.
      if (!(e instanceof AgentError)) console.error('Inhouse: could not invite.', e)
      setError(e instanceof AgentError && e.code === 'conflict' ? 'That email is already on the team.' : e instanceof AgentError && e.code === 'forbidden' ? "You can't invite people." : "Couldn't send the invite. Check the details and try again.")
    } finally { setBusy(false) }
  }

  const field = (id: string, label: string, value: string, set: (v: string) => void, extra?: { type?: string; hint?: string }) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-strong text-foreground-2">{label}{extra?.hint && <span className="ml-1.5 font-normal text-muted-foreground">{extra.hint}</span>}</Label>
      <Input id={id} type={extra?.type ?? 'text'} value={value} autoComplete="off" spellCheck={false} onChange={e => { set(e.target.value); setError(null) }}
        className="box-border h-9.5 rounded-lg bg-card px-3.25 text-base shadow-none md:text-base" />
    </div>
  )
  return (
    <Window onClose={onClose} label="Invite someone" size="sm" initialFocus="input">
      <WindowHeader title="Invite someone" description="They sign in with their work email." onClose={onClose} />
      <form className="flex flex-col gap-3.5 px-5.5 pt-3 pb-5.5" onSubmit={e => { e.preventDefault(); void send() }}>
        {field('invite-name', 'Name', name, setName)}
        {field('invite-email', 'Work email', email, setEmail, { type: 'email' })}
        {field('invite-title', 'Title', title, setTitle, { hint: 'Optional' })}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-strong text-foreground-2">Role</span>
          <Select label="Role" value={role} options={ROLES.map(([l]) => l)} onChange={setRole} align="left" />
        </div>
        {error && <p role="alert" className="m-0 text-sm text-destructive-text">{error}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" size="lg" onClick={onClose}>Cancel</Button>
          <Button size="lg" type="submit" disabled={busy}>Invite</Button>
        </div>
      </form>
    </Window>
  )
}
