// The hub's per-case config. wrangler dev prints a var's value only when it comes from a config file's `vars` (a `--var`, the
// environment and a local vars file all print "(hidden)"), so the runner can't both set SHOPIFY_SHOP from outside and read it
// back from wrangler's startup output. It writes a copy of the test hub config with the case's shop in `vars`, and the restart
// command starts wrangler on that copy (`{hubConfig}` in `--restart-cmd` is its path).

const VAR = /^(\s*"SHOPIFY_SHOP"\s*:\s*)"[^"\n]*"/m

/** The hub test config's text with `vars.SHOPIFY_SHOP` set to `shop`; throws unless the config has exactly that one line. */
export function hubConfigFor(text: string, shop: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(shop)) throw new Error(`hubConfigFor: ${shop} is not a shop handle`)
  if ((text.match(/"SHOPIFY_SHOP"\s*:/g) ?? []).length !== 1 || !VAR.test(text)) throw new Error('hubConfigFor: the config has no single "SHOPIFY_SHOP" var to set')
  return text.replace(VAR, `$1"${shop}"`)
}

/** `--restart-cmd` with `{hubConfig}` replaced by the config's path (quoted); throws when the command doesn't use it. */
export function commandFor(template: string, hubConfigPath: string): string {
  if (!template.includes('{hubConfig}')) throw new Error('--restart-cmd must contain {hubConfig}: the path of the per-case hub config')
  return template.replaceAll('{hubConfig}', `'${hubConfigPath.replaceAll("'", "'\\''")}'`)
}
