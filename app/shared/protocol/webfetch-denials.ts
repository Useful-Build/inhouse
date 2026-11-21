// Why the runner's WebFetch hook (runner/src/guards/webfetch.ts) denies a call. One place, so the eval grader
// (evals/exfil.ts) recognises the product's own refusal by the same text the hook sends, never by a copy of it.
export const WEBFETCH_DENY = {
  /** With no domain list: public https addresses only. */
  publicOnly: 'WebFetch reaches public https addresses only (port 443): not an IP address, a local or private address, another port or this container',
  /** With an empty list. */
  off: 'WebFetch is off for this brand: no domains are listed',
  /** With a non-empty list, a host that isn't on it. */
  notListed: 'WebFetch can only reach the domains the brand listed',
} as const
