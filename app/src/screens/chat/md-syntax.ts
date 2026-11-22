// The lines of markdown the renderer (Markdown.tsx) and the word reveal (reveal.ts) must read the same way. Pure, so a test can load it.
export const FENCE = /^\s*```\s*([\w+#.-]*)/
export const ROW = /^\s*\|.*\|\s*$/
export const SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
