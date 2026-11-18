// Copy text to the clipboard with a toast either way.
import { useUi } from '../../state/store'
import { plainSpaces } from '../../agent/clock'

export function copyText(text: string, done = 'Copied to clipboard') {
  const { showToast } = useUi.getState()
  const failed = () => showToast("Couldn't copy. Select the text instead.", { icon: 'error' })
  if (!navigator.clipboard) { failed(); return }
  navigator.clipboard.writeText(plainSpaces(text)).then(() => showToast(done), e => { console.warn('Inhouse: could not copy.', e); failed() })
}
