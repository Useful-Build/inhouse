// The graded runners' store check (P5 #337 round 2): before any spend, the brand's Tools page (route 70, `GET /api/tools`)
// must show Shopify connected, not paused and readable. Otherwise every graded turn's prompt would say no store is connected
// (or send v2) and the run would grade a prompt it never meant to: the product suite, the morning check and the store-data
// set refuse to start (exit 2).

/** Why the Tools page's answer doesn't show Shopify served, or null when it does. */
export function shopifyNotServed(tools: unknown): string | null {
  const t = (tools ?? {}) as { connected?: unknown; details?: Record<string, { paused?: unknown } | undefined>; connection?: Record<string, unknown> }
  if (!Array.isArray(t.connected) || !t.connected.includes('shopify')) return "Shopify is not connected on the brand's Tools page (route 70): connect it before a graded run"
  if (t.details?.shopify?.paused === true) return "Shopify is paused on the brand's Tools page (route 70): resume it before a graded run"
  if (t.connection && typeof t.connection === 'object' && t.connection.shopify !== undefined) return "Shopify can't be read now (route 70 lists its connection as failing): reconnect it before a graded run"
  return null
}
