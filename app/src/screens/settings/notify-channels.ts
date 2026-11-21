// The Slack notices page's hook (P5 W4) over its store (notify-store.ts): one store per Settings screen, open while the
// page is, toasts through the app's UI store.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { agent as appAgent } from '../../agent'
import { useUi } from '../../state/store'
import type { NotifyView } from './content'
import { createNotifyStore } from './notify-store'

export function useNotifyChannels(active: boolean, canEdit: boolean): NotifyView {
  const [st] = useState(() => createNotifyStore({ agent: appAgent, toast: text => useUi.getState().showToast(text, { icon: 'info', key: 'notify-channels' }) }))
  useEffect(() => (active ? st.open(canEdit) : undefined), [st, active, canEdit])
  const snap = useSyncExternalStore(st.subscribe, st.getSnapshot)
  return {
    ...snap, status: active ? snap.status : 'idle', canEdit,
    add: id => void st.add(id), remove: id => void st.remove(id), setAlerts: id => void st.setAlerts(id), retry: () => void st.retry(),
  }
}
