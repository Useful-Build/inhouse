// The OS side of the pool, on a temp folder (no root here: ownership changes are recorded, not made). Ways it could
// fail, written first:
// - the session folder isn't 1770 to the session's group, or `.claude/` and `.mcp.json` aren't root's with the stubs;
// - a symlink the session left is followed (a chown or a recursion through it reaches outside the folder);
// - a symlink or file squatting on `inputs`, `outputs` or `.claude` survives the take-over;
// - the user's home or temp folder sits inside the session folder, or in a folder a session can write (it could swap
//   either for a symlink), or stays open to others (or closed to its owner) after a session changed its mode;
// - a file from the uid's last session is still in its home or temp folder when the next one starts: the wipe skips
//   those folders, removes only the uid's own files there, or passes with something left;
// - the wipe empties those folders as root, by path, rather than as the uid;
// - a file someone other than a session user owns is handed to the session;
// - a parked folder stays open to the last session's group;
// - the wipe removes another user's files, follows a symlink, or misses the user's files deeper down;
// - killAll returns while a process of the uid is still alive (zombies aside), or loops forever on one that won't die;
// - killAll skips its kill(-1) because the first listing looked empty, or calls a zombie leader whose other threads
//   still run dead (a main thread that called pthread_exit);
// - the /proc parser misses the saved or filesystem uid or the thread count, or calls a dead process alive;
// - the wipe runs as root by path (a swapped symlink steers root's delete), misses /dev/mqueue, or leaves the uid's
//   SysV objects;
// - a hard-linked file is handed to the next user (it could be another uid's file);
// - inputs/ or outputs/ are the session's to rename (and swap for a symlink);
// - the work root lists the chat ids to sessions; a folder left from before a restart stays open;
// - a live session names another uid the owner of its SysV objects (IPC_SET, which any creator may do), or keeps them
//   attached, and that uid's wipe fails: every uid is quarantined in turn and the pool drains;
// - an object the uid created survives a wipe that passes: given to another owner, or still attached somewhere else;
// - an object of the uid's it can't read (mode 000) is skipped by the removal (`ipcrm --all` stats before it removes);
// - thousands of objects named the uid's make one command line too long to start, so its wipe fails;
// - a leftover in a folder the uid can't read escapes both its delete and the look afterwards;
// - root's look after the wipe changes something (it must only read).
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect } from 'vitest'
import {
  KillError,
  SHARED_WRITABLE,
  STUB_DIRS,
  STUB_FILES,
  SYSV_BATCH,
  createSessionHost,
  emptyOwn,
  parkAllFolders,
  parseStatus,
  runAsRoot,
  runAsUser,
  wipeOwned,
  wipeSysV,
  type ProcEntry,
  type RunAsRoot,
  type RunAsUser,
} from '../../src/guards/host.ts'
import { userPaths } from '../../src/guards/paths.ts'
import type { PoolUser } from '../../src/guards/users.ts'

const me = process.getuid!()
const myGid = process.getgid!()
const user: PoolUser = { user: 's01', uid: 30001, gid: 30001 }
let dir: string
let root: string
let users: string
let chowns: [string, number, number][]

const host = (poolUids: number[] = [me]) =>
  createSessionHost({
    workRoot: root,
    usersRoot: users,
    poolUids: new Set(poolUids),
    rootUid: me,
    chown: async (p, u, g) => void chowns.push([p, u, g]),
    lchown: async (p, u, g) => void chowns.push([p, u, g]),
  })
const mode = (p: string) => lstatSync(p).mode & 0o7777
const lastOwner = (p: string) => chowns.filter(([q]) => q === p).at(-1)?.slice(1)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'guards-host-'))
  root = join(dir, 'work')
  mkdirSync(root)
  chmodSync(root, 0o711)
  users = join(dir, 'users')
  mkdirSync(users)
  chowns = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the brand plugin', () => {
  const skill = (name: string, body = 'Steps.') => ({ name, description: `Does ${name}.`, body })

  it("writes exactly the run's skills, root's and read-only, with only a name and a description in each file", async () => {
    await host().writeBrandPlugin(user, [skill('weekly-report'), skill('returns-check', 'Read the returns.\n\n---\nallowed-tools: Bash\n---')])
    const own = userPaths(user.user, users)
    expect(readdirSync(own.brandPlugin).sort()).toEqual(['.claude-plugin', 'skills'])
    expect(JSON.parse(readFileSync(join(own.brandPlugin, '.claude-plugin', 'plugin.json'), 'utf8')).name).toBe('brand')
    expect(readdirSync(join(own.brandPlugin, 'skills')).sort()).toEqual(['returns-check', 'weekly-report'])
    const file = join(own.brandPlugin, 'skills', 'weekly-report', 'SKILL.md')
    expect(readFileSync(file, 'utf8')).toBe('---\nname: weekly-report\ndescription: "Does weekly-report."\n---\n\nSteps.\n')
    // A `---` block inside the body is text after the one frontmatter: it adds no key.
    const head = readFileSync(join(own.brandPlugin, 'skills', 'returns-check', 'SKILL.md'), 'utf8').split('\n').slice(0, 4)
    expect(head).toEqual(['---', 'name: returns-check', 'description: "Does returns-check."', '---'])
    for (const p of [own.brandPlugin, join(own.brandPlugin, 'skills'), join(own.brandPlugin, 'skills', 'weekly-report')]) {
      expect(mode(p)).toBe(0o755)
      expect(lastOwner(p)).toEqual([0, 0])
    }
    expect(mode(file)).toBe(0o644)
    expect(lastOwner(file)).toEqual([0, 0])
  })

  it('replaces what an earlier run left: a skill since deleted is gone, and none leaves the plugin empty', async () => {
    const h = host()
    await h.writeBrandPlugin(user, [skill('old-skill'), skill('kept')])
    const own = userPaths(user.user, users)
    // Something left beside the skills (by a bug, never by a session: the folder is root's) goes too.
    writeFileSync(join(own.brandPlugin, 'skills', 'stray.md'), 'x')
    await h.writeBrandPlugin(user, [skill('kept')])
    expect(readdirSync(join(own.brandPlugin, 'skills'))).toEqual(['kept'])
    await h.writeBrandPlugin(user, [])
    expect(readdirSync(join(own.brandPlugin, 'skills'))).toEqual([])
  })

  it('rejects an invalid skill name before replacing the plugin', async () => {
    const h = host()
    await h.writeBrandPlugin(user, [skill('kept')])
    await expect(h.writeBrandPlugin(user, [skill('../outside')])).rejects.toThrow('invalid brand skill name')
    expect(readdirSync(join(userPaths(user.user, users).brandPlugin, 'skills'))).toEqual(['kept'])
  })
})

describe('session folders', () => {
  it('makes the stubs layout for the session user', async () => {
    const { workDir, home } = await host().prepareFolder('chat1', user)
    expect(workDir).toBe(join(root, 'chat1'))
    expect(mode(workDir)).toBe(0o1770)
    expect(lastOwner(workDir)).toEqual([0, user.gid])
    expect(mode(join(workDir, '.claude'))).toBe(0o755)
    expect(lastOwner(join(workDir, '.claude'))).toEqual([0, 0])
    for (const d of STUB_DIRS) expect(lstatSync(join(workDir, '.claude', d)).isDirectory()).toBe(true)
    for (const [f, text] of Object.entries(STUB_FILES)) {
      expect(readFileSync(join(workDir, '.claude', f), 'utf8')).toBe(text)
      expect(lastOwner(join(workDir, '.claude', f))).toEqual([0, 0])
    }
    expect(readFileSync(join(workDir, '.mcp.json'), 'utf8')).toBe('{}')
    expect(lastOwner(join(workDir, '.mcp.json'))).toEqual([0, 0])
    // inputs/ and outputs/ are root's, open to the session's group: the session can't rename them (sticky parent).
    for (const d of ['inputs', 'outputs']) {
      expect(mode(join(workDir, d))).toBe(0o1770)
      expect(lastOwner(join(workDir, d))).toEqual([0, user.gid])
    }
    // The home and the temp folder are the user's own, outside the session folder, in a folder of root's.
    const own = userPaths(user.user, users)
    expect(home).toBe(own.home)
    expect(readdirSync(workDir).sort()).toEqual(['.claude', '.mcp.json', 'inputs', 'outputs'])
    expect(mode(own.dir)).toBe(0o755)
    expect(lstatSync(own.dir).uid).toBe(me)
    expect(lastOwner(own.dir)).toBeUndefined()
    for (const d of [own.home, own.tmp]) {
      expect(mode(d)).toBe(0o700)
      expect(lastOwner(d)).toEqual([user.uid, user.gid])
    }
  })

  it("closes the user's own folders to everyone else again, and keeps what's in them for the wipe", async () => {
    const h = host()
    await h.prepareFolder('chat1', user)
    const own = userPaths(user.user, users)
    chmodSync(own.home, 0o777)
    chmodSync(own.tmp, 0o000)
    await h.prepareFolder('chat2', user)
    for (const d of [own.home, own.tmp]) expect(mode(d)).toBe(0o700)
    // Root never deletes in there (a session could steer a delete by path): the wipe does, as the uid.
    writeFileSync(join(own.home, 'kept'), 'x')
    await h.prepareFolder('chat3', user)
    expect(readdirSync(own.home)).toEqual(['kept'])
  })

  it("refuses a users root, or a user's folder in it, that isn't a folder of root's", async () => {
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(users, user.user))
    await expect(host().prepareFolder('chat1', user)).rejects.toThrow(/owned by root/)
    expect(readdirSync(outside)).toEqual([])
    rmSync(users, { recursive: true })
    symlinkSync(outside, users)
    await expect(host().prepareFolder('chat1', user)).rejects.toThrow(/owned by root/)
    expect(readdirSync(outside)).toEqual([])
    // Nothing was opened to the session on the way.
    expect(existsSync(join(root, 'chat1'))).toBe(false)
  })

  it('never hands over a hard-linked file', async () => {
    const h = host()
    const { workDir } = await h.prepareFolder('chat1', user)
    writeFileSync(join(workDir, 'outputs', 'a'), 'x')
    linkSync(join(workDir, 'outputs', 'a'), join(workDir, 'outputs', 'b'))
    writeFileSync(join(workDir, 'outputs', 'c'), 'x')
    chowns = []
    await h.prepareFolder('chat1', { user: 's02', uid: 30002, gid: 30002 })
    expect(lastOwner(join(workDir, 'outputs', 'a'))).toBeUndefined()
    expect(lastOwner(join(workDir, 'outputs', 'b'))).toBeUndefined()
    expect(lastOwner(join(workDir, 'outputs', 'c'))).toEqual([30002, 30002])
  })

  it('refuses a work root that lists its folders to sessions', async () => {
    chmodSync(root, 0o755)
    await expect(host().prepareFolder('chat1', user)).rejects.toThrow(/0711/)
  })

  it('hands what the last session made to the new user, without following symlinks', async () => {
    const h = host()
    const { workDir } = await h.prepareFolder('chat1', user)
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret'), 'x')
    writeFileSync(join(workDir, 'outputs', 'report.pdf'), 'x')
    symlinkSync(outside, join(workDir, 'outputs', 'link'))
    symlinkSync(outside, join(workDir, 'loose-link'))
    chowns = []
    const next: PoolUser = { user: 's02', uid: 30002, gid: 30002 }
    await h.prepareFolder('chat1', next)
    expect(lastOwner(join(workDir, 'outputs', 'report.pdf'))).toEqual([next.uid, next.gid])
    // The links themselves change hands; nothing behind them is touched.
    expect(lastOwner(join(workDir, 'outputs', 'link'))).toEqual([next.uid, next.gid])
    expect(chowns.some(([p]) => p.startsWith(outside))).toBe(false)
    expect(lastOwner(join(workDir, '.claude'))).toEqual([0, 0])
  })

  it('leaves a file no session user owns as it is', async () => {
    const { workDir } = await host().prepareFolder('chat1', user)
    writeFileSync(join(workDir, 'outputs', 'roots'), 'x')
    chowns = []
    // `me` is not in the pool here, so every file looks like someone else's.
    await host([30001]).prepareFolder('chat1', user)
    expect(lastOwner(join(workDir, 'outputs', 'roots'))).toBeUndefined()
  })

  it('replaces whatever squats on the names root and the session rely on', async () => {
    const workDir = join(root, 'chat1')
    mkdirSync(workDir, { mode: 0o700 })
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(workDir, 'outputs'))
    writeFileSync(join(workDir, 'inputs'), 'not a dir')
    symlinkSync(outside, join(workDir, '.claude'))
    symlinkSync(join(outside, 'x.json'), join(workDir, '.mcp.json'))
    await host().prepareFolder('chat1', user)
    for (const d of ['inputs', 'outputs', '.claude']) expect(lstatSync(join(workDir, d)).isDirectory(), d).toBe(true)
    expect(lstatSync(join(workDir, '.mcp.json')).isFile()).toBe(true)
    expect(readdirSync(outside)).toEqual([])
  })

  it('parks a folder closed to every session user, and parking a missing folder is fine', async () => {
    const h = host()
    const { workDir } = await h.prepareFolder('chat1', user)
    await h.parkFolder('chat1')
    expect(mode(workDir)).toBe(0o700)
    expect(lastOwner(workDir)).toEqual([0, 0])
    await expect(h.parkFolder('nothing-here')).resolves.toBeUndefined()
  })

  it('refuses an unsafe key and a work root that is a symlink', async () => {
    await expect(host().prepareFolder('../x', user)).rejects.toThrow()
    rmSync(root, { recursive: true })
    mkdirSync(join(dir, 'real'))
    symlinkSync(join(dir, 'real'), root)
    await expect(host().prepareFolder('chat1', user)).rejects.toThrow(/owned by root/)
  })
})

type SysVObject = { kind: 'shm' | 'msg' | 'sem'; id: number; uid: number; cuid: number; attached?: boolean; unreadable?: boolean }
/** The kernel's own header lines (ipc/shm.c, msg.c and sem.c; the 64-bit shm one). */
const SYSV_HEAD = {
  shm: '       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid      atime      dtime      ctime                   rss                  swap',
  msg: '       key      msqid perms      cbytes       qnum lspid lrpid   uid   gid  cuid  cgid      stime      rtime      ctime',
  sem: '       key      semid perms      nsems   uid   gid  cuid  cgid      otime      ctime',
}
const SYSV_FLAG: Record<string, SysVObject['kind']> = { '-m': 'shm', '-q': 'msg', '-s': 'sem' }

/**
 * The kernel's SysV table as /proc/sysvipc shows it, and `ipcrm` as the kernel answers it: a removal is the owner's or
 * the creator's to make and nobody else's; a segment still attached somewhere stays, marked (perms 1xxx, key 0), until
 * its last detach; `--all` stats each object before it removes it, so it skips what its caller can't read.
 */
function sysvKernel(objects: SysVObject[]) {
  const sysv = join(dir, 'proc', 'sysvipc')
  mkdirSync(sysv, { recursive: true })
  const left = new Set(objects)
  const marked = new Set<SysVObject>()
  const calls: [PoolUser, string[]][] = []
  const row = (o: SysVObject) => {
    const perms = ((marked.has(o) ? 0o1000 : 0) | (o.unreadable ? 0 : 0o600)).toString(8)
    const head = `${marked.has(o) ? 0 : 4096 + o.id} ${o.id} ${perms}`
    const who = `${o.uid} ${o.uid} ${o.cuid} ${o.cuid}`
    if (o.kind === 'shm') return `${head} 4096 10 10 ${o.attached ? 1 : 0} ${who} 0 0 0 4096 0`
    return o.kind === 'msg' ? `${head} 0 0 0 0 ${who} 0 0 0` : `${head} 1 ${who} 0 0`
  }
  const show = () => {
    for (const kind of ['shm', 'msg', 'sem'] as const) {
      writeFileSync(join(sysv, kind), [SYSV_HEAD[kind], ...[...left].filter((o) => o.kind === kind).map(row)].join('\n') + '\n')
    }
  }
  const remove = (u: PoolUser, o: SysVObject) => {
    if (o.uid !== u.uid && o.cuid !== u.uid) return
    if (o.kind === 'shm' && o.attached) marked.add(o)
    else left.delete(o)
  }
  const run: RunAsUser = async (u, cmd, args) => {
    if (cmd !== 'ipcrm') return { code: 0, stdout: '' }
    calls.push([u, args])
    if (args.includes('--all')) {
      for (const o of [...left]) if (!o.unreadable) remove(u, o)
    } else {
      const byId = new Map([...left].map((o) => [`${o.kind} ${o.id}`, o]))
      for (let i = 0; i < args.length; i += 2) {
        const o = byId.get(`${SYSV_FLAG[args[i]!]} ${args[i + 1]}`)
        if (o) remove(u, o)
      }
    }
    show()
    return { code: 0, stdout: '' }
  }
  show()
  return { sysv, run, left, calls }
}

const POOL = [30001, 30002, 30003, 30004]
/** Any table: each object's owner is whoever its creator (or last owner) named, any pool uid. */
const sysvObjects = (creators: number[]) =>
  fc.uniqueArray(
    fc.record({
      kind: fc.constantFrom('shm' as const, 'msg' as const, 'sem' as const),
      id: fc.nat(99_999),
      uid: fc.constantFrom(...POOL),
      cuid: fc.constantFrom(...creators),
      attached: fc.boolean(),
      unreadable: fc.boolean(),
    }),
    { maxLength: 12, selector: (o) => `${o.kind} ${o.id}` },
  )
/** After a wipe of `user`: what's still in the table must be exactly this. */
const stays = (o: SysVObject, its: boolean) => (its ? o.kind === 'shm' && o.attached === true : true)

describe('the wipe', () => {
  const self: PoolUser = { user: 'me', uid: me, gid: myGid }
  const quiet: RunAsUser = async () => ({ code: 0, stdout: '' })

  it("removes the user's files at any depth and nothing else, without following symlinks (real find, as this uid)", async () => {
    const tmp = join(dir, 'tmp')
    const outside = join(dir, 'outside')
    mkdirSync(join(tmp, 'a', 'b'), { recursive: true })
    mkdirSync(join(tmp, 'locked'))
    writeFileSync(join(tmp, 'locked', 'f'), 'x')
    chmodSync(join(tmp, 'locked'), 0o000)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'x')
    writeFileSync(join(tmp, 'a', 'b', 'f'), 'x')
    symlinkSync(outside, join(tmp, 'link'))
    // Not the uid we wipe: everything stays.
    await wipeOwned(tmp, { ...self, uid: me + 1 }, (_u, cmd, args) => runAsUser(self, cmd, args), runAsRoot)
    expect(existsSync(join(tmp, 'a', 'b', 'f'))).toBe(true)
    await wipeOwned(tmp, self, runAsUser, runAsRoot)
    expect(readdirSync(tmp)).toEqual([])
    expect(readdirSync(outside)).toEqual(['keep'])
    await expect(wipeOwned(join(dir, 'missing'), self, runAsUser, runAsRoot)).resolves.toBeUndefined()
  })

  it("empties the uid's own folder, whoever owns what's in it and however it was closed, without following symlinks (real find, as this uid)", async () => {
    const own = join(dir, 'own')
    const outside = join(dir, 'outside')
    mkdirSync(join(own, 'a', 'b'), { recursive: true })
    writeFileSync(join(own, 'a', 'b', 'f'), 'x')
    writeFileSync(join(own, '.hidden'), 'x')
    mkdirSync(join(own, 'locked'))
    writeFileSync(join(own, 'locked', 'f'), 'x')
    chmodSync(join(own, 'locked'), 0o000)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'x')
    symlinkSync(outside, join(own, 'link'))
    // Closed to its owner too: the wipe still gets in.
    chmodSync(own, 0o000)
    // No `-user` test: a file another uid left in it goes too (here every file is this uid's; the arguments say it).
    const ran: string[][] = []
    await emptyOwn(own, self, (u, cmd, args) => (ran.push(args), runAsUser(u, cmd, args)), runAsRoot)
    expect(readdirSync(own)).toEqual([])
    expect(readdirSync(outside)).toEqual(['keep'])
    for (const args of ran) expect(args).not.toContain('-user')
    await expect(emptyOwn(join(dir, 'missing'), self, runAsUser, runAsRoot)).resolves.toBeUndefined()
  })

  it("throws when anything is left in the uid's own folder, and root's look removes nothing", async () => {
    const own = join(dir, 'own')
    mkdirSync(join(own, 'theirs'), { recursive: true })
    writeFileSync(join(own, 'theirs', 'f'), 'x')
    // Another uid's closed folder in it: the uid's own commands can't empty it.
    const blind: RunAsUser = async () => ({ code: 1, stdout: '' })
    await expect(emptyOwn(own, self, blind, runAsRoot)).rejects.toThrow(/own folder still holds .*theirs/)
    expect(existsSync(join(own, 'theirs', 'f'))).toBe(true)
  })

  it('throws when something of the uid is still there after the delete', async () => {
    const stuck: RunAsRoot = async () => ({ code: 0, stdout: '/tmp/stuck\n' })
    await expect(wipeOwned('/tmp', self, quiet, stuck)).rejects.toThrow(/stuck/)
  })

  it("finds a leftover the uid itself can't reach: the look afterwards is root's (real find), and it removes nothing", async () => {
    const tmp = join(dir, 'tmp')
    mkdirSync(join(tmp, 'closed'), { recursive: true })
    writeFileSync(join(tmp, 'closed', 'f'), 'x')
    // The folder is another uid's and closed to this one: its own commands reach nothing in it and print nothing.
    const blind: RunAsUser = async () => ({ code: 1, stdout: '' })
    await expect(wipeOwned(tmp, self, blind, runAsRoot)).rejects.toThrow(/still owns .*closed/)
    expect(existsSync(join(tmp, 'closed', 'f'))).toBe(true)
  })

  it('changes things only as the uid itself; root only looks', async () => {
    const calls: [PoolUser, string, string[]][] = []
    const looks: [string, string[]][] = []
    const k = sysvKernel([{ kind: 'shm', id: 7, uid: user.uid, cuid: user.uid }])
    const h = createSessionHost({
      workRoot: root,
      poolUids: new Set(),
      procDir: join(dir, 'proc'),
      runAsUser: async (u, cmd, args) => (calls.push([u, cmd, args]), k.run(u, cmd, args)),
      runAsRoot: async (cmd, args) => (looks.push([cmd, args]), { code: 0, stdout: '' }),
    })
    await h.wipeUserFiles(user)
    expect(calls.length).toBeGreaterThan(0)
    for (const [u] of calls) expect(u).toEqual(user)
    const finds = calls.filter(([, cmd]) => cmd === 'find')
    const own = userPaths(user.user)
    for (const d of [own.home, own.tmp]) expect(finds.some(([, , a]) => a[0] === d && a.includes('-delete')), d).toBe(true)
    for (const d of SHARED_WRITABLE) {
      const mine = finds.filter(([, , a]) => a[0] === d)
      expect(mine.some(([, , a]) => a.includes('-delete')), d).toBe(true)
      for (const [, , a] of mine) expect(a).toEqual(expect.arrayContaining(['-xdev', '-user', String(user.uid)]))
    }
    // Root's part, in full: one find per place that prints the first thing it sees (in the uid's own folders,
    // anything; in the shared ones, anything of the uid's). No delete, no exec.
    expect(looks).toEqual([
      ...[own.home, own.tmp].map((d) => ['find', [d, '-xdev', '-mindepth', '1', '-print', '-quit']]),
      ...SHARED_WRITABLE.map((d) => ['find', [d, '-xdev', '-mindepth', '1', '-user', String(user.uid), '-print', '-quit']]),
    ])
    expect(SHARED_WRITABLE).toContain('/dev/mqueue')
    expect(calls.filter(([, cmd]) => cmd === 'ipcrm').map(([, , a]) => a)).toEqual([['-m', '7']])
    expect(k.left.size).toBe(0)
  })

  it("throws when one of the uid's SysV objects survives", async () => {
    const sysv = join(dir, 'proc', 'sysvipc')
    mkdirSync(sysv, { recursive: true })
    writeFileSync(join(sysv, 'shm'), '       key      shmid perms       size  cpid  lpid nattch   uid   gid  cuid  cgid\n         0          7   600       4096    10    10      0 30001 30001 30001 30001\n')
    writeFileSync(join(sysv, 'sem'), '       key      semid perms      nsems   uid   gid  cuid  cgid\n         0          3   600          1 30002 30002 30002 30002\n')
    const h = createSessionHost({ workRoot: root, poolUids: new Set(), procDir: join(dir, 'proc'), runAsUser: quiet, runAsRoot: async () => ({ code: 0, stdout: '' }) })
    // The thrown text names the place and the error's name only (P8a P-auth: a wipe's own message names a leftover file).
    await expect(h.wipeUserFiles(user)).rejects.toThrow(/^sysv:Error$/)
    await expect(h.wipeUserFiles({ ...user, uid: 30003 })).resolves.toBeUndefined()
  })

  it("tries the uid's own folders, every shared folder and the SysV wipe before it throws, then throws every failure", async () => {
    const k = sysvKernel([{ kind: 'shm', id: 7, uid: user.uid, cuid: user.uid }])
    const looked: string[] = []
    const h = createSessionHost({
      workRoot: root,
      poolUids: new Set(),
      procDir: join(dir, 'proc'),
      runAsUser: k.run,
      // The first three places keep a leftover: the rest, and the SysV wipe, still run.
      runAsRoot: async (_cmd, args) => (looked.push(args[0]!), { code: 0, stdout: looked.length <= 3 ? `${args[0]}/stuck\n` : '' }),
    })
    const err = await h.wipeUserFiles(user).then(() => null, (e: Error) => e)
    const own = userPaths(user.user)
    expect(looked).toEqual([own.home, own.tmp, ...SHARED_WRITABLE])
    expect(k.left.size).toBe(0)
    // Every failure, as its place and the error's name: never the leftover's path (P8a P-auth: a file name is chat content).
    expect(err?.message).toBe(`home:Error; tmp:Error; ${SHARED_WRITABLE[0]}:Error`)
  })

  it("a row that only names the uid as owner never fails its wipe; a row it created does, whoever owns it now (the kernel's own text)", async () => {
    // 30002 made segment 7, named 30001 its owner (IPC_SET) and stays attached. Either uid's removal only marks it
    // (perms 1600, key 0): it lives until 30002 detaches.
    const sysv = join(dir, 'proc', 'sysvipc')
    mkdirSync(sysv, { recursive: true })
    const row = '         0          7  1600                  4096    10    10      1 30001 30001 30002 30002          0          0 1795000000                  4096                     0'
    writeFileSync(join(sysv, 'shm'), `${SYSV_HEAD.shm}\n${row}\n`)
    const ran: [number, string[]][] = []
    const run: RunAsUser = async (u, _cmd, args) => (ran.push([u.uid, args]), { code: 1, stdout: '' })
    await expect(wipeSysV(user, run, sysv)).resolves.toBeUndefined()
    await expect(wipeSysV({ user: 's02', uid: 30002, gid: 30002 }, run, sysv)).rejects.toThrow(/uid 30002 created .*SysV shm.*\b7\b/)
    // Both tried to remove it, each as itself: the owner may, and so may the creator.
    expect(ran).toEqual([
      [30001, ['-m', '7']],
      [30002, ['-m', '7']],
    ])
  })

  it.prop([sysvObjects([30002, 30003, 30004])])(
    "no other uid can make this uid's wipe fail: whatever they create, give it or keep attached, it passes",
    async (objects) => {
      const k = sysvKernel(objects)
      await expect(wipeSysV(user, k.run, k.sysv)).resolves.toBeUndefined()
      // What it was named the owner of it removes anyway (an attached segment goes on its last detach); the rest stays.
      for (const o of objects) expect(k.left.has(o), JSON.stringify(o)).toBe(stays(o, o.uid === user.uid))
    },
  )

  it.prop([sysvObjects(POOL)])(
    'nothing the uid created outlives a wipe that passes: it fails exactly when something it created is still there',
    async (objects) => {
      const k = sysvKernel(objects)
      const stuck = objects.filter((o) => o.cuid === user.uid && o.kind === 'shm' && o.attached)
      const wiped = wipeSysV(user, k.run, k.sysv)
      if (stuck.length > 0) await expect(wiped).rejects.toThrow(/created .*SysV shm/)
      else await expect(wiped).resolves.toBeUndefined()
      // Whether it passed or not: everything it owns or created that can go is gone, the unreadable included, every
      // removal ran as the uid itself, and nothing of anyone else's was touched.
      for (const o of objects) expect(k.left.has(o), JSON.stringify(o)).toBe(stays(o, o.uid === user.uid || o.cuid === user.uid))
      for (const [u] of k.calls) expect(u).toEqual(user)
      if (stuck.length === 0) expect([...k.left].filter((o) => o.cuid === user.uid)).toEqual([])
    },
  )

  it('removes by id in batches, so no number of objects makes a command too long to start', async () => {
    const objects: SysVObject[] = Array.from({ length: SYSV_BATCH * 2 + 3 }, (_, i) => ({ kind: 'msg', id: i, uid: user.uid, cuid: 30002 }))
    const k = sysvKernel(objects)
    await wipeSysV(user, k.run, k.sysv)
    expect(k.left.size).toBe(0)
    expect(k.calls.map(([, a]) => a.length)).toEqual([SYSV_BATCH * 2, SYSV_BATCH * 2, 6])
  })

  it('a kernel without SysV IPC has nothing to remove; a table without the id or uid columns is refused', async () => {
    const ran: string[] = []
    const run: RunAsUser = async (_u, cmd) => (ran.push(cmd), { code: 0, stdout: '' })
    await expect(wipeSysV(user, run, join(dir, 'no-sysvipc'))).resolves.toBeUndefined()
    expect(ran).toEqual([])
    const sysv = join(dir, 'proc', 'sysvipc')
    mkdirSync(sysv, { recursive: true })
    writeFileSync(join(sysv, 'msg'), '       key      msqid perms\n         0          1   600\n')
    await expect(wipeSysV(user, run, sysv)).rejects.toThrow(/columns/)
  })

  it("the real runners: a command as the given uid, and root's as the runner itself", async () => {
    await expect(runAsUser(self, 'true', [])).resolves.toMatchObject({ code: 0 })
    // Not root here: switching to another uid is refused, which shows the uid is really set.
    await expect(runAsUser({ user: 'x', uid: me + 1, gid: myGid }, 'true', [])).rejects.toThrow(/EPERM/)
    await expect(runAsRoot('id', ['-u'])).resolves.toEqual({ code: 0, stdout: `${me}\n` })
  })
})

describe('parking every folder at start', () => {
  it('parks every folder and closes the work root to listing', () => {
    mkdirSync(join(root, 'a'), { mode: 0o770 })
    mkdirSync(join(root, 'b'), { mode: 0o1770 })
    chmodSync(root, 0o755)
    parkAllFolders({ workRoot: root, rootUid: me, lchownSync: (p, u, g) => void chowns.push([p, u, g]) })
    for (const d of ['a', 'b']) {
      expect(mode(join(root, d))).toBe(0o700)
      expect(lastOwner(join(root, d))).toEqual([0, 0])
    }
    expect(mode(root)).toBe(0o711)
  })

  it('refuses to start on anything in the work root that is not a root folder', () => {
    symlinkSync(dir, join(root, 'link'))
    expect(() => parkAllFolders({ workRoot: root, rootUid: me, lchownSync: () => {} })).toThrow(/link/)
  })
})

describe('killAll', () => {
  function table(procs: (ProcEntry & { immortal?: boolean })[]) {
    const live = new Map(procs.map((p) => [p.pid, p]))
    let clock = 0
    let kills = 0
    return {
      live,
      kills: () => kills,
      deps: {
        workRoot: root,
        poolUids: new Set<number>(),
        listProcs: async () => [...live.values()],
        killPid: (pid: number) => {
          const p = live.get(pid)
          if (!p) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
          if (!p.immortal) live.delete(pid)
        },
        // kill(-1) as the user: everything of its uid that can die, dies (a zombie leader with live threads too).
        killAsUser: async (u: PoolUser) => {
          kills++
          for (const [pid, p] of live) if (p.uids.includes(u.uid) && !p.immortal && (!p.zombie || p.threads > 1)) live.delete(pid)
        },
        pause: async (ms: number) => void (clock += ms),
        now: () => clock,
        killDeadlineMs: 100,
      },
    }
  }

  it('returns only once no process of the uid is left; zombies and other uids are ignored', async () => {
    const t = table([
      { pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false, threads: 1 },
      { pid: 11, uids: [0, 0, 30001, 0], zombie: false, threads: 1 },
      { pid: 12, uids: [30001, 30001, 30001, 30001], zombie: true, threads: 1 },
      { pid: 13, uids: [30002, 30002, 30002, 30002], zombie: false, threads: 1 },
    ])
    await createSessionHost(t.deps).killAll(user)
    expect([...t.live.keys()].sort()).toEqual([12, 13])
  })

  it('counts a zombie leader whose other threads still run as alive, and kills it', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: true, threads: 3 }])
    await createSessionHost(t.deps).killAll(user)
    expect(t.live.size).toBe(0)
  })

  it('sends kill(-1) as the user once even when the first listing shows nothing', async () => {
    const t = table([])
    await createSessionHost(t.deps).killAll(user)
    expect(t.kills()).toBe(1)
  })

  it('kills by pid when kill(-1) as the user fails', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false, threads: 1 }])
    await createSessionHost({ ...t.deps, killAsUser: async () => Promise.reject(new Error('EAGAIN')) }).killAll(user)
    expect(t.live.size).toBe(0)
  })

  it('throws, after the deadline, on a process that will not die', async () => {
    const t = table([{ pid: 10, uids: [30001, 30001, 30001, 30001], zombie: false, threads: 1, immortal: true }])
    await expect(createSessionHost(t.deps).killAll(user)).rejects.toThrow(KillError)
  })
})

describe('parseStatus', () => {
  const status = (state: string, uid: string, threads = 1) =>
    `Name:\tbash\nState:\t${state}\nTgid:\t7\nPid:\t7\nUid:\t${uid}\nGid:\t30001\t30001\t30001\t30001\nThreads:\t${threads}\n`
  it('reads all four uids, the zombie state and the thread count', () => {
    expect(parseStatus(7, status('S (sleeping)', '0\t0\t30001\t0'))).toEqual({ pid: 7, uids: [0, 0, 30001, 0], zombie: false, threads: 1 })
    expect(parseStatus(7, status('Z (zombie)', '30001\t30001\t30001\t30001', 4))?.threads).toBe(4)
    expect(parseStatus(7, status('Z (zombie)', '30001\t30001\t30001\t30001'))?.zombie).toBe(true)
    expect(parseStatus(7, 'garbage')).toBeNull()
  })
})
