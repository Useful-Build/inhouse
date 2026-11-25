// The base Code Block parts for the trace window's Technical drawer. Kept out of trace.tsx and the `src/ui/agent` barrel:
// the steps line (in Today's entry chunk) imports those, and anything they name loads with Today's first paint
// (scripts/check-bundle.mjs). Only lazy chunks import this file (build-support/entry-graph.test.ts pins it).
export {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFooter,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ui/code-block'
