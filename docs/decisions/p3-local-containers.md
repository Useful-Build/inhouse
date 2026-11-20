# S6: the runner under `wrangler dev`, with the SDK sandbox and one OS user per session (2026-11-20)

Wave 0 spike for P3 ([plan](../plans/2026-11-19-p3-agent-chat.md), S6). Question: does one chat run end to end with the
runner image under `wrangler dev`, with the SDK sandbox on and one OS user per session? Three legs were planned: the
Mac, a GitHub runner, and the ship job's Playwright container. Code: the runner harness (`app/runner/harness/`) with
the scripted model, and the check `app/runner/harness/s6-check.mjs` (PR #102). No model calls, no secrets.

## Verdicts

1. **The sandbox can't start under `wrangler dev` on any leg we can run.** On the Mac, with Rosetta 2 (re-run 2026-11-20), the
   CLI runs and a chat with no tool finishes, but bwrap can't `pivot_root`: Docker's default seccomp profile denies it
   and `wrangler dev` offers no way to change that. On a GitHub runner, rootful Docker
   gives the container no privileges, so bwrap can't make a user namespace. Rootless Docker gets the Mac's privileges,
   but bwrap still can't `pivot_root`, and the runner's egress breaks too.
2. **Everything except the sandbox works.** The image builds and starts under `wrangler dev`. Each chat runs as its own
   pool user (uid 30000 and up), never as root. `/protocol` answers the runner's version.
3. **The guard holds.** With no sandbox, the CLI refuses the agent's Bash call (`failIfUnavailable`,
   `allowUnsandboxedCommands: false`). It never runs it unsandboxed.
4. **Decision Q2 applies** (below).

## Leg 1: the Mac

Runs with Colima, wrangler 4.162.0. `wrangler dev` always builds and pulls `linux/amd64` (hard-coded), so a native
arm64 image isn't an option without patching wrangler.

| Fact | Result |
|---|---|
| Image build and start under `wrangler dev` | works; `/health` in 125 s cold (with the build), 7 to 10 s warm |
| Container privileges from `wrangler dev` | `SYS_ADMIN`, `apparmor:unconfined` (miniflare grants them on macOS) |
| One OS user per session | chats ran as `s00` (30000) and `s01` (30001) |
| Emulation | Rosetta 2 isn't installed, so Colima falls back to qemu binfmt: every process runs under `qemu-x86_64` |
| Namespaces | `bwrap --unshare-pid` and `unshare -U` fail with "Invalid argument", as the session user and as root |
| The CLI | a Bun-built amd64 binary; crashes at start under qemu: "CPU lacks AVX support", segmentation fault |
| `open EEXIST` on fd 0 | a real R1 bug, not emulation: the session channel opened fds 0 and 1 as its own sockets and clashed with `process.stdin`. Found in #78, fixed by moving the channel to fds 3 and 4 (#83). It hit every platform |

Verdict: blocked on Rosetta 2 (or an arm64 runner image). Not a code bug. Rosetta 2 translates user code only, so
pipes and namespaces reach the real kernel; then the same `s6-check.mjs` can run unchanged under the heavy lock.

### Leg 1 re-run with Rosetta 2 (2026-11-20, runs mac-5 and mac-6)

Evidence: `verify/backend-impl/s6/mac-5/`, `mac-6/` and `mac-6-diagnosis.md` (private verify folder).

| Fact | Result |
|---|---|
| Emulation | Rosetta handles x86_64 in the Colima VM (`qemu-x86_64` disabled); session processes run as `/mnt/lima-rosetta/rosetta node ...`. The CLI starts (the AVX crash is gone) |
| mac-5 | every chat refused at the sandbox: the VM is Ubuntu and `apparmor_restrict_unprivileged_userns` stops bwrap. The CLI refused rather than run Bash unsandboxed (the guard held) |
| mac-6 (VM-only `sysctl kernel.apparmor_restrict_unprivileged_userns=0`, as `ci.yml` does on its runner) | the `hello` chat (no tool) finishes end to end under the sandbox; the `write-output` chat's Bash runs inside bwrap and fails with `bwrap: pivot_root: Operation not permitted`, as the session user and as root |
| Cause | Docker's default seccomp profile has no `pivot_root` entry, so the call gets the profile's default `EPERM` even with `SYS_ADMIN` (moby `default.json`; Docker's seccomp docs list "Deny pivot_root"). miniflare grants `SYS_ADMIN`, `/dev/fuse` and `apparmor:unconfined` on macOS but has no seccomp or systempaths option; `ci.yml`'s probes pass `seccomp`, `apparmor` and `systempaths=unconfined` |
| A fix that keeps every guard | none documented for `wrangler dev`. A daemon-wide seccomp profile would clear `pivot_root` only; masked `/proc` paths come next and have no daemon-wide setting. The rest means patching miniflare or swapping the OCI runtime |

Verdict: Q2 stands for the Mac too. The Mac is a local path for everything except sandboxed tool calls.

## Leg 2: a GitHub runner (native amd64)

CI job `runner-dev` (removed after S6; in git history at e48242e), ubuntu-latest, wrangler 4.162.0, Docker 29.4.2,
CLI 2.1.328, SDK 0.3.328, bubblewrap 0.8.0. The host's userns sysctls allow user namespaces
(`unprivileged_userns_clone=1`), and the job set Ubuntu's AppArmor userns restriction to 0 and unloaded the host's
`bwrap-userns-restrict` profile, as the `runner` job does. Three runs per leg: `hello` on chat-a, then `write-output`
(Bash writes `outputs/table.csv`) on chat-c and chat-b, with `ps` sampled every 20 ms inside the container.

- Rootful Docker: [run 44690702045](https://github.com/Useful-Build/inhouse/actions/runs/44690702045) (f5ea3f5)
- Rootless Docker, by Docker's documented install path: [run 44691459085](https://github.com/Useful-Build/inhouse/actions/runs/44691459085) (3a42795)

| Fact | Rootful | Rootless |
|---|---|---|
| Container privileges from `wrangler dev` | none: `CapAdd null`, `SecurityOpt null`, no devices, Docker's default seccomp and AppArmor | `SYS_ADMIN`, `apparmor:unconfined`, `/dev/fuse` (the same as the Mac) |
| Why | miniflare's `containerPrivilegesAllowed()` grants them only on macOS, WSL, or Linux with rootless Docker and `/dev/fuse` | that rule now matches; wrangler warns "Creating a container with explicitly configured Docker privileges" |
| `unshare -U` as a pool user | "Operation not permitted" (default seccomp refuses `CLONE_NEWUSER` without `SYS_ADMIN`) | works |
| bwrap as a pool user | "No permissions to create new namespace" | **`pivot_root: Operation not permitted`** |
| Cold start to `/health` (with the image build) | 103 s | 94 s |
| `hello` | passes (1.3 s): the scripted answer, `finished success` | fails before the session: `failed reason: files` |
| `write-output` | the Bash call fails on the bwrap error and the CLI refuses it (no unsandboxed run); no file | fails before the session: `failed reason: files` |
| The runner's egress | works | every call gets `read ECONNRESET`, and the harness's egress never sees it |
| Pool users | chat-a 30000, chat-c 30001, chat-b 30002; never root | the same |
| `/protocol` | 1, matching `/health` and the source | the same |
| bwrap seen under a session uid | never | never |

Not proven, in the rootless column:
- **`pivot_root`:** the likely cause is mounts locked or masked from the outer namespaces (Docker's masked `/proc`
  paths, which the `runner` job lifts with `systempaths=unconfined`, an option `wrangler dev` can't pass). Not chased
  further: one round was the budget.
- **`ECONNRESET`:** an inference. The container's way out is wrangler's `proxy-everything` sidecar back to workerd on
  the host, and rootless Docker's network can't reach the host's loopback by default.

Not tried: `--privileged`, changing the Docker daemon's seccomp or AppArmor defaults (not a setup a developer gets from
wrangler), and patching wrangler or miniflare.

## Leg 3: the ship job's Playwright container

Not run. Legs 1 and 2 already trigger Q2, and this leg would run the same `wrangler dev` setup beside the ship job's
Playwright container.

## Decision

Q2 applies, as written in the [backend plan's open questions](../plans/2026-11-19-backend.md):

> A test-build deployment per PR in the sandbox account only (invented data, the scripted model, the test issuer), as a
> named exception to "no test code in a deployed build", locked to that account by the config check. Never tests with
> the sandbox off

Tests never run with the sandbox off.

## Owed

- A deployed run of the runner image on Cloudflare: the sandbox and one OS user per session in production.
- The Q2 test deployment itself, in P3's chat track.
