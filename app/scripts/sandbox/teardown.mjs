// Per-PR teardown: what to delete for a set of PRs, and the deletions themselves. Shared by cleanup.mjs (closed PRs)
// and deploy.mjs (the PR it redeploys, so each deploy starts from an empty database). Names come only from the app
// repo's scripts/sandbox/names.mjs (`perPrNames`): a resource is deleted only when its name is EXACTLY one of a PR's
// names, never by prefix, and the name is checked again right before its delete call.
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { isSafeKey } from './cloudflare.mjs'

/** The app repo's name guard and lock, from a checkout of its main (`--app <that checkout>/app`). */
export async function loadApp(appDir) {
  const names = await import(pathToFileURL(resolve(appDir, 'scripts/sandbox/names.mjs')).href)
  const lock = await import(pathToFileURL(resolve(appDir, 'scripts/check-product-config.mjs')).href)
  return { ...names, checkSandboxConfig: lock.checkSandboxConfig, readSandboxConfig: lock.readSandboxConfig, stripJsonc: lock.stripJsonc }
}

/** Every PR number a per-PR name in the listing belongs to (Workers, domains' Workers, D1, R2, container apps, images). */
export function prsInListing(listing, app) {
  const seen = new Set()
  const add = name => { const n = app.prNumberOf(name); if (n !== null) seen.add(n) }
  listing.workers.forEach(add)
  listing.domains.forEach(d => add(d.service))
  listing.d1.forEach(d => add(d.name))
  listing.r2.forEach(add)
  listing.containers.forEach(c => add(c.name))
  listing.images.forEach(i => add(i.name))
  return [...seen].sort((a, b) => a - b)
}

/**
 * The deletions for `prs`, in order per PR: its custom domains, its Worker, then its hub Worker (P4; the product binds
 * the hub, so it goes first), its container application, its D1, its R2 bucket (emptied first), then its runner images'
 * tags in the registry, except `keepImageTags` (the deploy keeps the tag it just pushed).
 * Also what was seen but left alone, with why: a per-PR-shaped name this tool never makes, or a domain on a PR's Worker
 * whose hostname isn't one of that PR's two hosts.
 */
export function planTeardown(listing, prs, { app, zone, keepImageTags = [] }) {
  const deletions = []
  const skipped = []
  const wanted = new Set(prs)
  for (const pr of [...wanted].sort((a, b) => a - b)) {
    const names = app.perPrNames(pr)
    const hosts = new Set([`${names.brand}.${zone}`, `${names.team}.${zone}`])
    for (const d of listing.domains.filter(d => d.service === names.worker)) {
      if (hosts.has(d.hostname)) deletions.push({ pr, kind: 'domain', name: d.hostname, id: d.id })
      else skipped.push({ name: d.hostname, why: `a custom domain on ${names.worker} that isn't one of PR ${pr}'s hosts` })
    }
    if (listing.workers.includes(names.worker)) deletions.push({ pr, kind: 'worker', name: names.worker })
    if (names.hub && listing.workers.includes(names.hub)) deletions.push({ pr, kind: 'hub', name: names.hub })
    // The container application the Worker's deploy made (it outlives the Worker), by its exact name.
    for (const c of listing.containers.filter(c => c.name === names.container)) deletions.push({ pr, kind: 'container', name: c.name, id: c.id })
    for (const d of listing.d1.filter(d => d.name === names.d1)) deletions.push({ pr, kind: 'd1', name: d.name, id: d.uuid })
    if (listing.r2.includes(names.r2)) deletions.push({ pr, kind: 'r2', name: names.r2 })
    for (const i of listing.images.filter(i => i.name === names.image)) {
      for (const tag of i.tags) if (!keepImageTags.includes(tag)) deletions.push({ pr, kind: 'image', name: names.image, tag })
    }
  }
  // Per-PR-shaped names that aren't exactly a name this tool makes: reported, never deleted.
  const made = new Set()
  for (const pr of prsInListing(listing, app)) {
    const names = app.perPrNames(pr)
    for (const n of [names.worker, names.d1, names.r2, names.hub, names.image]) if (n) made.add(n)
  }
  for (const name of [...listing.workers, ...listing.containers.map(c => c.name), ...listing.d1.map(d => d.name), ...listing.r2, ...listing.images.map(i => i.name)]) {
    if (app.isPerPrName(name) && !made.has(name)) skipped.push({ name, why: 'per-PR-shaped, but not a name this tool makes' })
  }
  return { deletions, skipped }
}

/**
 * Runs the deletions, logging each one. `dryRun` only logs. Every name is checked against `perPrNames` of its PR right
 * before its call; a mismatch throws before anything else is deleted.
 */
export async function runTeardown(cf, deletions, { app, zone, dryRun, log }) {
  for (const d of deletions) {
    const names = app.perPrNames(d.pr)
    const expected = { worker: [names.worker], hub: [names.hub], container: [names.container], image: [names.image], d1: [names.d1], r2: [names.r2], domain: [`${names.brand}.${zone}`, `${names.team}.${zone}`] }[d.kind]
    if (!expected?.includes(d.name)) throw new Error(`refusing to delete ${d.kind} ${JSON.stringify(d.name)}: not PR ${d.pr}'s`)
    if (d.kind !== 'domain') app.assertPerPrName(d.name, d.pr)
    const what = `${d.kind} ${d.name}${d.tag ? `:${d.tag}` : ''}${d.id ? ` (${d.id})` : ''} of PR ${d.pr}`
    if (dryRun) {
      log(`would delete ${what}`)
      if (d.kind === 'r2') log(`would empty ${d.name} first`)
      continue
    }
    if (d.kind === 'domain') await cf.detachDomain(d.id)
    else if (d.kind === 'worker' || d.kind === 'hub') await cf.deleteWorker(d.name)
    else if (d.kind === 'container') await cf.deleteContainerApp(d.id)
    else if (d.kind === 'd1') await cf.deleteD1(d.id)
    else if (d.kind === 'image') await cf.deleteImage(d.name, d.tag)
    else if (d.kind === 'r2') {
      const keys = await cf.r2Keys(d.name)
      // A key with an empty, '.' or '..' segment (a PR's code can write any key) is never sent: it stays, and the bucket
      // delete below then fails loudly for a person to look at.
      const unsafe = keys.filter(k => !isSafeKey(k))
      for (const key of keys) if (isSafeKey(key)) await cf.deleteR2Object(d.name, key)
      for (const key of unsafe) log(`left in ${d.name}: ${JSON.stringify(key)} (an empty, '.' or '..' segment; delete it by hand)`)
      log(`emptied ${d.name} (${keys.length - unsafe.length} of ${keys.length} objects)`)
      await cf.deleteR2(d.name)
    }
    log(`deleted ${what}`)
  }
}

/** The account's Workers, custom domains, D1 databases, R2 buckets, container applications and registry images. */
export async function listAll(cf) {
  const [workers, domains, d1, r2, containers, images] = [await cf.workers(), await cf.domains(), await cf.d1(), await cf.r2(), await cf.containerApps(), await cf.images()]
  return { workers, domains, d1, r2, containers, images }
}
