// The thread's hold (src/ui/agent/thread.tsx): its own file, so thread.tsx exports only components (fast refresh).
/**
 * Keeps the view where it is while something in the thread opens (Show more, an answer's steps or sources): the reader asked
 * for it, so the view must not follow it down. A wheel event on the viewport is Message Scroller's own "the reader took
 * over" signal; @shadcn/react 0.3.1 has no public call for it.
 */
export function holdView(viewport: HTMLElement | null): void {
  if (!viewport) throw new Error('holdView: the thread has no scroll box to hold.')
  viewport.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }))
}
