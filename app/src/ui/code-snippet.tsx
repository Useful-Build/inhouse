// A fenced block of code or other plain text (an answer's code block): the base CodeBlock (size sm, plain text, no
// syntax highlighting) in the app's look, with its always-visible Copy button. Screens use this, not the base file.
import { CodeBlock, CodeBlockContent } from '@/components/ui/code-block'
import { IconButton } from './index'

/**
 * `label` names the scrollable region (a keyboard can scroll a long line sideways); `copyLabel` names the Copy button;
 * `onCopy` runs with the block's text. `data-md-code` marks the block for the specs.
 */
export function CodeSnippet({ text, label, copyLabel, onCopy }: { text: string; label: string; copyLabel: string; onCopy: (text: string) => void }) {
  return (
    <CodeBlock size="sm" data-md-code className="rounded-xl border-0 data-[size=sm]:text-sm">
      <CodeBlockContent role="region" aria-label={label}
        className="py-3 group-data-[size=sm]/code-block:py-3 group-data-[size=sm]/code-block:pr-11 group-data-[size=sm]/code-block:pl-3.5 leading-prose">{text}</CodeBlockContent>
      <IconButton icon="content_copy" label={copyLabel} size={16} box="icon-sm" className="absolute top-1.5 right-1.5 bg-muted hover:bg-fill-hover" onClick={() => onCopy(text)} />
    </CodeBlock>
  )
}
