// The small remark and rehype steps around Streamdown's own: what the old renderer did that GFM does not.
// Structural types only (the trees are mdast and hast): no unified or unist import, none is a direct dependency.

interface Node { type: string; value?: string; children?: Node[]; tagName?: string; properties?: Record<string, unknown>; align?: (string | null)[] }

/** Raw HTML is never passed through: it shows as the text it was written as (an answer that names `<order-id>` keeps it). */
export function remarkHtmlAsText() {
  const FLOW = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])
  const walk = (node: Node) => {
    if (!node.children) return
    node.children = node.children.map(child => {
      if (child.type !== 'html') { walk(child); return child }
      const text: Node = { type: 'text', value: child.value ?? '' }
      return FLOW.has(node.type) ? { type: 'paragraph', children: [text] } : text
    })
  }
  return walk
}

/** A row with more cells than the header widens the table (the extra headers are blank): GFM would drop those cells. */
export function remarkTableWidth() {
  const walk = (node: Node) => {
    if (node.type === 'table' && node.children?.length) {
      const head = node.children[0]
      const width = Math.max(...node.children.map(r => r.children?.length ?? 0))
      const cells = head.children ?? []
      while (cells.length < width) cells.push({ type: 'tableCell', children: [] })
      head.children = cells
      node.align = Array.from({ length: width }, (_, i) => node.align?.[i] ?? null)
    }
    node.children?.forEach(walk)
  }
  return walk
}

/** `HTTPS://host/` is https: the sanitizer step reads a scheme as written and would drop an address with a capital in it. */
export function rehypeLowercaseSchemes() {
  return (tree: Node) => {
    const walk = (node: Node) => {
      if (node.type === 'element' && node.properties) {
        for (const key of ['href', 'src']) {
          const v = node.properties[key]
          if (typeof v === 'string') node.properties[key] = v.replace(/^([a-z][a-z0-9+.-]*):/i, (_, scheme: string) => `${scheme.toLowerCase()}:`)
        }
      }
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}

/** Numbers the code blocks and tables of the text in order (`dataMdN`), so each region and Copy button has its own name. */
export function rehypeNumberBlocks() {
  return (tree: Node) => {
    let code = 0, table = 0
    const walk = (node: Node) => {
      if (node.type === 'element' && (node.tagName === 'pre' || node.tagName === 'table')) {
        node.properties = { ...node.properties, dataMdN: node.tagName === 'pre' ? ++code : ++table }
      }
      node.children?.forEach(walk)
    }
    walk(tree)
  }
}
