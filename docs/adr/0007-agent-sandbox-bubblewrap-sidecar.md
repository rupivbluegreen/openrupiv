# 0007 — Agent tool sandbox: per-execution bubblewrap jails in a dedicated sidecar (no docker.sock)

- Status: proposed — **human-only review path** (CLAUDE.md: sandbox
  boundaries). This ADR and the `packages/sandbox` implementation it
  authorizes must be reviewed and accepted by a human maintainer before
  merge; no agent session may merge either autonomously.
- Date: 2026-07-06

## Context

`specs/phase-2.md` names the tool sandbox "the highest-risk surface in the
whole project" and a non-negotiable: *"The Python tool sandbox is a real
isolation boundary (human-only review path). No network by default; resource
limits; no host filesystem access beyond an explicit workspace; every tool
call policy-checked and audited."* Acceptance criterion 7 is concrete: *"a
tool attempting network egress or host FS access outside its workspace is
blocked and audited."* PLAN.md's non-negotiable stack line names
"TypeScript-primary, Python tool sandbox" as a first-class pillar, not an
afterthought.

`specs/phase-2-contracts.md` §4 already froze the *shape* of the boundary,
deliberately technology-agnostic, and explicitly deferred the mechanism to
this ADR:

```ts
export interface SandboxLimits {
  wallClockMs: number;
  memoryBytes: number;
  maxOutputBytes: number;
}

export interface SandboxExecuteInput {
  tool: RegisteredTool;
  input: Record<string, unknown>;
  workspaceDir: string; // absolute host path of the per-run workspace
  limits: SandboxLimits;
}

export type SandboxExecuteResult =
  | { ok: true; output: unknown; durationMs: number }
  | { ok: false; reason: "violation"; violation: "network_egress" | "fs_escape"; ... }
  | { ok: false; reason: "limit"; limit: "wall_clock" | "memory" | "output_size"; ... }
  | { ok: false; reason: "tool_error"; ... };

export interface ToolSandbox {
  execute(input: SandboxExecuteInput): Promise<SandboxExecuteResult>;
}
```

That contract note says the limits are "REQUIRED — no defaults in this
contract (values fixed in ADR-0007)" and that "implementations MUST satisfy
the workspace, egress, and limit semantics ... without this interface
changing." This ADR fixes the mechanism and the limit values; it does not
reopen §4's `callTool` enforcement order (allowlist → schema → OPA `decide`
→ audit-before → `sandbox.execute` → audit-after), which stays exactly as
specified and entirely inside `@openrupiv/agents` in the TS runtime process.

Three constraints shape the decision:

1. **The tool being sandboxed is adversarial by default, not merely buggy.**
   Agent tools can originate from MCP connectors, from the generator, or
   from third parties. The boundary must assume the tool process actively
   tries to exfiltrate data, escape to the host, or exhaust resources —
   not just that it might crash.
2. **The quickstart is `git clone` + `docker compose up`, on a developer's
   laptop or Docker Desktop, with no host-level runtime install.** Any
   mechanism requiring a host kernel module, a privileged runtime install
   (gVisor, Kata, Firecracker), or `/dev/kvm` breaks that promise outright
   for v1.
3. **Air-gap and Apache-2.0 posture are load-bearing project claims**
   (PLAN.md, CLAUDE.md non-negotiable 1). Whatever is chosen must build
   fully offline from pinned sources and must not put a copyleft obligation
   on anything the project links or vendors.

Four broad mechanism families were on the table: (a) hand a tool call to
`docker run` over a mounted `docker.sock`; (b) run an OS-level unprivileged
jail (bubblewrap/nsjail) directly inside the existing `@openrupiv/runtime`
web container; (c) run the same kind of jail in a dedicated sidecar
container with no filesystem or process relationship to the runtime; (d) run
tool code in a memory-safe sandboxed *language* runtime (WASM) instead of a
kernel-level jail around a real interpreter. A three-judge design review
considered these and unanimously decided (c), detailed below. This ADR
documents that decision rigorously; it does not re-litigate it.

## Decision

**Add a `sandbox` service — a dedicated, unprivileged sidecar container
(`packages/sandbox`) — that runs one bubblewrap (`bwrap`) jail per tool
execution, using unprivileged Linux user namespaces. `docker.sock` is never
mounted, referenced, or reachable anywhere in this design.** The existing
`ToolSandbox` interface is implemented by a thin HTTP client,
`createSidecarSandbox({ baseUrl, token })`; the interface itself does not
change.

```
 @openrupiv/agents (callTool, in the runtime container)
   1 allowlist  2 schema  3 policy.decide  4 audit-before
        │
        ▼  (5) sandbox.execute(...)  — createSidecarSandbox HTTP client
 ============================ compose network (internal) ============================
        │  POST /v1/execute   Authorization: Bearer <SANDBOX_TOKEN>
        ▼
 [ sandbox service — read_only:true, no published ports, no host mounts ]
   TS supervisor (Node 22)
        │  fork/exec, no shell, pinned argv from bwrap-argv.ts
        ▼
   bwrap --unshare-{user,pid,net,ipc,uts} --die-with-parent --new-session
     --clearenv --seccomp <fd: inner filter> --ro-bind <python+wheels> ...
     --bind /workspaces/<runId> /workspace
        │
        ▼
   [ jailed CPython process — no netns interface, no host FS, RLIMIT_* set ]
 =======================================================================================
        │  classified JSON result only
        ▼
 back to (6) audit-after, in the runtime container
```

The sidecar holds **no policy logic**. It does not know about roles,
`AgentIdentity`, OPA, or the audit log. Its bearer-token check is
*authentication* ("is this caller allowed to talk to me at all"), never
*authorization* ("should this specific tool call happen") — that decision
has already been made, and audited, by `@openrupiv/agents` before step (5)
ever fires. The sidecar's only two jobs are: hold the isolation boundary
correctly, and refuse to do anything at all without a valid token.

### Mechanism

**Image and build.** `packages/sandbox/Dockerfile`, built from the monorepo
root exactly like `packages/runtime/Dockerfile` (workspace manifests copied
first for layer caching, `pnpm install --frozen-lockfile`), so both images
share the same reproducible-build posture. Base image: a **digest-pinned**
`python:3.12-slim-bookworm@sha256:<pinned-at-bump-time>` (Debian trixie's
`bwrap` package is installed from the distro repos, not compiled from
source) plus Node 22 (via the distro `nodejs`/`corepack`, or a second
digest-pinned stage copied in — implementation detail for the build stage,
not this ADR). This ADR fixes the *base tag and the pinning policy*
(digest-pinned, bumped only via a reviewable PR that updates the digest, CI
re-verifies the pin resolves and the image still builds), not a specific
digest value — a digest recorded today is stale the moment a security patch
ships upstream, and hard-coding one into an ADR would itself become a
silently-stale claim. Node 22 runs the **supervisor only**; Python 3.12 plus
hash-pinned vendored wheels are what gets bound **read-only inside each
jail** as the tool execution runtime (PLAN.md's "Python tool sandbox"
pillar). The supervisor never executes tool code directly — its only
privileged action is constructing and exec'ing a pinned `bwrap` argv.

**Compose wiring.** A new `sandbox` service, generated by `openrupiv new`
alongside `postgres`/`dex`/`runtime` (same pattern as
`packages/cli/src/workspace-files.ts`): built from `${OPENRUPIV_REPO}` with
`dockerfile: packages/sandbox/Dockerfile`, on an **`internal: true`**
Compose network shared only with `runtime` (no route to `dex`/`postgres`,
no published host ports at all — not even for debugging), `read_only:
true` with a scratch `tmpfs` for the container's own `/tmp`, a healthcheck
gated on the boot canary (below), and `security_opt` carrying exactly two
documented deltas from Docker's defaults: a **loosened seccomp profile**
(committed as a small diffable JSON file, e.g.
`packages/sandbox/docker-seccomp.json`) permitting `unshare`, `clone` (with
namespace flags), `mount`, `umount2`, and `pivot_root` — the handful of
syscalls Docker's stock profile blocks specifically to stop nested
namespace creation, which is the entire mechanism bubblewrap needs — and
`apparmor: unconfined`, because `docker-default` AppArmor also denies mount
operations bubblewrap requires. **No added Linux capabilities, no
`privileged: true`, no `CAP_SYS_ADMIN`.** That last point is bubblewrap's
whole value proposition over rejected alternative (1) below: *unprivileged*
user namespaces grant the jailed process capabilities only inside its own
new namespaces, never on the host or the sidecar container's real view of
the world.

**Supervisor API.** A minimal TS HTTP server exposes exactly one route,
`POST /v1/execute`, taking `{ runId, tool, input, limits }` (the same shape
`SandboxExecuteInput` carries, minus the host path — see runId handling
below) and returning a `SandboxExecuteResult`-shaped JSON body. The bearer
token comes from `SANDBOX_TOKEN` in the generated workspace `.env`
(`openrupiv new` generates it the same way it generates `SESSION_SECRET`
today — a random ≥32-char value, gitignored, wired into both the `runtime`
and `sandbox` Compose environments). Token comparison is constant-time and
length-independent: both the presented and expected token are SHA-256
hashed first (fixed 32-byte digests), then compared with
`crypto.timingSafeEqual` — comparing raw tokens directly is unsafe because
`timingSafeEqual` requires equal-length buffers and would either throw or
leak length via that mismatch. The raw token is never written to a log line
or an audit record in any code path, success or failure; only "token
present / absent / valid / invalid" is ever recorded. The route lives only
on the internal Compose network with no published port — a caller must
already be inside the trust boundary of the Compose stack to reach it at
all; the token is a second, independent gate on top of that.

**`runId` handling — the wire never carries a trusted host path.** The
`ToolSandbox` contract's `workspaceDir` field predates this ADR and is
deliberately technology-agnostic; naively forwarding an "absolute host
path" string across an HTTP boundary between two containers that do not
share a filesystem would be meaningless at best and a path-confusion bug at
worst. `createSidecarSandbox`'s `execute()` treats `workspaceDir` as
carrying an opaque per-run identifier in its final path segment (a UUID),
extracts and **re-validates** it against a strict UUID v4 regex client-side
before sending, and transmits only `{ runId, ... }` — never a path string —
in the request body. The sidecar independently re-validates `runId` against
the same strict regex server-side and computes the jail's bind path
**exclusively** as `<sidecar's own /workspaces mount>/<runId>`; it never
dereferences, joins, or trusts any caller-supplied path. Any `runId` that
fails the regex, or any attempt to smuggle a path (`../`, an absolute path,
a symlink target) where a `runId` is expected, is a 400 before any jail is
constructed — never "helpfully" normalized and used anyway.

**Per-call jail construction.** A single module,
`packages/sandbox/src/bwrap-argv.ts`, is the *only* place a `bwrap` argv is
assembled — never string-interpolated into a shell, always
`execFile`/`spawn` with an argv array, so there is no injection surface by
construction. It is unit-tested with golden argv snapshots for representative
inputs, and is the seam the nsjail licensing fallback (below) would swap
behind. The fixed argv:

- `--unshare-user --unshare-pid --unshare-net --unshare-ipc --unshare-uts`
  — private everything; no shared kernel namespace with the host or with
  any other concurrent jail.
- `--die-with-parent --new-session` — the jail cannot outlive the
  supervisor's fork/exec call, and cannot escape process-group signal
  delivery (no orphaned jailed processes surviving a supervisor crash).
- `--clearenv`, then an explicit minimal env allowlist (`PATH`, `HOME=/tmp`,
  `PYTHONDONTWRITEBYTECODE=1`, nothing carrying secrets — the jail never
  sees `SANDBOX_TOKEN`, `DATABASE_URL`, or any runtime credential, because
  the supervisor process holding those never forwards its own environment).
- **RO binds** of the Python 3.12 runtime and hash-pinned vendored wheels
  (installed via `pip install --require-hashes` at image-build time, never
  fetched at run time) — the only code present inside the jail.
- **Exactly one RW bind**: `/workspaces/<runId>` (created by the supervisor
  as a fresh, empty, `0700` subdirectory immediately before the call, owned
  by the container's own unprivileged user — the same convention
  `packages/runtime/Dockerfile` uses for dropping root) mapped to
  `/workspace` inside the jail. Deleted best-effort after the run;
  deletion failures are logged, never silently swallowed, and never block
  returning the result to the runtime.
- `--proc /proc` private (a fresh, empty procfs for the jail's own PID
  namespace — no view of host or sibling-jail processes) and `--tmpfs /tmp`
  (jail-local scratch, gone when the jail exits).
- `--seccomp <fd>` pointing at the **second, inner** seccomp filter
  (distinct from the outer container's loosened profile above — see next
  section), plus bubblewrap's own baked-in `no_new_privs`.

**A second, stricter seccomp filter applies inside the jail.** This is
independent of, and stacks on top of, the outer container's loosened
profile — the outer delta exists so bubblewrap itself can *build* a jail;
the inner filter exists so code *running inside* that jail cannot do
anything bubblewrap didn't explicitly intend, even having inherited a
process tree that already has namespace-creation rights. `SECCOMP_RET_KILL_
PROCESS` (not `ERRNO` — a policy violation inside the jail is a
non-negotiable kill, not a retriable error the tool code could catch and
work around) on:

- `mount`, `ptrace`, `bpf`, `keyctl`, `userfaultfd`, `io_uring_setup` /
  `io_uring_enter` / `io_uring_register`, `process_vm_readv` /
  `process_vm_writev`, `open_by_handle_at`, `perf_event_open` — the
  syscalls most consistently behind real unprivileged-userns Linux kernel
  LPEs.
- Nested user-namespace creation: `clone`/`unshare` with `CLONE_NEWUSER`,
  **and** `clone3` unconditionally returning `ENOSYS` rather than being
  flag-inspected. Seccomp filters can inspect `clone`'s `flags` argument
  directly, but `clone3` takes a pointer to a `struct clone_args` in
  userspace memory — seccomp cannot dereference that pointer to check which
  namespace flags it requests, so any flag-based re-denial of `clone3`
  would be trivially bypassable by a jailed process constructing its own
  `struct clone_args`. The only sound mitigation is denying `clone3`
  outright, independent of arguments.
- `socket()` restricted to `AF_UNIX` only. `AF_UNIX` is safe to allow —
  with `--unshare-net` the jail has no network namespace interface at all,
  and Linux scopes the abstract-socket namespace per network namespace, so
  even abstract `AF_UNIX` sockets stay confined to the jail — and Python's
  standard library (`multiprocessing`, `asyncio` internals) reflexively
  creates them. Every other family is denied, **explicitly including
  `AF_NETLINK`** — not merely `AF_INET`/`AF_INET6`/`AF_PACKET`, since
  `nf_tables`/netfilter CVEs reachable via `AF_NETLINK` sockets are the
  canonical unprivileged-userns kernel-LPE route in the current CVE
  landscape, and it would be an oversight to deny only the "obviously a
  network socket" families and leave that one open.

The rule source (a small declarative syscall→action list) is compiled to a
BPF program via the `libseccomp` toolchain and **committed** as a versioned,
hash-pinned build artifact
(`packages/sandbox/seccomp/tool.bpf`) — exactly the precedent ADR-0006 set
for the committed `authz.wasm`: a `scripts/build-seccomp.sh` recompiles it,
and a CI job (mirroring `policy-wasm` in `.github/workflows/ci.yml`)
rebuilds-and-diffs the committed `.bpf` against its rule source whenever the
toolchain is available, skipping loudly (never silently) otherwise, so the
committed filter can never go silently stale relative to the rules a
reviewer actually read.

**Result handling — the workspace is hostile after the run.** The runtime
consumes results **only** from the sidecar's classified JSON response body
(`SandboxExecuteResult`); it never mounts, opens, or otherwise touches the
sidecar's `/workspaces` tree — the two containers share no filesystem, by
design. The party that *does* touch the raw workspace directory after a run
is the supervisor itself, cleaning it up: it treats every path inside it as
attacker-controlled (a jailed process could plant a symlink pointing
anywhere reachable from the *supervisor's* (non-jailed) view of the
container filesystem) and resolves any workspace-relative path with
`O_NOFOLLOW` plus a `realpath` check that the canonical result still falls
under the run's own workspace root before touching it — never a bare
`rm -rf <path>` or `open()` on an attacker-influenced path string. This rule
also binds any future capability that lets the runtime or supervisor read a
named file out of a workspace (e.g., an artifact-download endpoint) rather
than receiving output purely inline in the JSON body — none exists in v1,
and none may be added without the same confinement.

**Tool `entrypoint` is untrusted input too, even though it is
allowlisted upstream.** `RegisteredTool.entrypoint` is opaque to
`@openrupiv/agents` by contract; the sidecar is the only party that
resolves it to an actual executable path. It requires the resolved,
canonicalized path to fall under its own RO tool root before exec'ing it —
never "close enough," never a bare string concatenation — so that even a
bug upstream in allowlist/registration logic cannot turn into an arbitrary
exec inside the jail.

### Network: three independent layers

1. **No interface at all.** `--unshare-net` gives the jail a private,
   loopback-only network namespace with nothing else attached — there is
   no cable to cut, because there is no cable.
2. **The inner seccomp filter kills `socket()` for anything but `AF_UNIX`,
   non-cooperatively.** A network-egress attempt is classified from the
   jail's exit status/signal (`SIGSYS`) by the supervisor, never from any
   in-jail shim's self-report — a compromised or merely buggy tool process
   cannot claim "no violation occurred" because it never gets to run past
   the syscall in the first place.
3. **The `sandbox` service itself sits on an `internal: true` Compose
   network with no published ports**, as a wall that holds even against a
   *complete* jail escape (namespaces + seccomp both defeated): the
   attacker still lands inside a `read_only`, capless, unprivileged
   container with no route to the internet, to `postgres`, or to `dex`,
   and no `docker.sock` to pivot from.

### Filesystem model

RO binds (Python interpreter, stdlib, hash-pinned vendored wheels) are the
*only* code present in the jail. Exactly one RW bind, the per-run
workspace. Everything else is either absent from the mount namespace
entirely (`ENOENT` — most host paths, since bubblewrap builds the jail's
root from nothing but explicit binds, not a copy-then-restrict of the host
root) or read-only (`EROFS` — anything intentionally bound RO). The sidecar
container's own filesystem is `read_only: true` with a `tmpfs` for its own
scratch space, distinct from the per-run workspace tree the supervisor
manages on a regular (non-tmpfs) mount — conflating "container scratch" and
"per-run workspace" would make workspace sizing interact unpredictably with
the memory-accounting caveats in the next section.

### Resource limits

**Inner (per-execution), from the required `SandboxLimits`, with fixed ADR
defaults** — these are the values the contract deferred to this ADR:

| Limit | Mechanism | Default |
|---|---|---|
| Wall clock | supervisor timer, `SIGKILL`s the `bwrap` parent (torn down via `--die-with-parent`) | `wallClockMs: 30_000` (30s) |
| Memory | `RLIMIT_AS` inside the jail | `memoryBytes: 268_435_456` (256 MiB) |
| Output size | supervisor caps the captured stdout/stderr/response payload | `maxOutputBytes: 1_048_576` (1 MiB) |
| Process count | `RLIMIT_NPROC` | 16 |
| CPU time | `RLIMIT_CPU`, a belt-and-suspenders backstop in case the wall-clock timer fails to fire | 30s |
| Max file size | `RLIMIT_FSIZE` (bounds any single file the tool writes inside the workspace — independent of `maxOutputBytes`, which bounds the *captured response*, not on-disk writes) | 64 MiB |
| Open file descriptors | `RLIMIT_NOFILE` | 256 |

Plus a **supervisor-level concurrency cap of 4** simultaneous jails (an
in-process semaphore around the fork/exec call); requests beyond the cap
queue up to a small bounded depth and are then rejected outright rather
than queued unboundedly — an unbounded queue would itself be a DoS vector.
The supervisor sets its own `oom_score_adj` lower (less likely to be
killed) than the `oom_score_adj` it sets on jailed children (bumped up,
more likely to be killed), so that if the outer container's cgroup memory
limit is hit, the kernel OOM killer prefers to kill a tool jail over the
process holding the concurrency semaphore and serving `/v1/execute`.

**Outer (Compose/cgroup-v2)**: plain `mem_limit`, `cpus`, and `pids_limit`
knobs on the `sandbox` service — operational tuning, not part of this
ADR's frozen per-execution contract, but this ADR requires operators (and
the generated Compose stanza's defaults) to size them against the honest
aggregate math below, not against wishful thinking:

> Four concurrent jails at 256 MiB `RLIMIT_AS` each is a **256 MiB × 4 =
> 1 GiB** raw floor — before accounting for the Node supervisor process's
> own resident memory, the page-cache cost of the RO binds (shared across
> jails but still counted against the container's cgroup on first touch),
> and workspace scratch. `RLIMIT_AS` also bounds *virtual address space*,
> not RSS as the cgroup memory controller accounts it — some allocators
> reserve address space well beyond what they actually commit, so
> `RLIMIT_AS` is a conservative but **not exact** proxy for cgroup memory
> pressure. The generated Compose default sets `mem_limit` to roughly
> **2 GiB** for the default concurrency cap of 4 — a documented v1
> approximation, not exact per-jail accounting. **Exact accounting is a
> committed Phase 3 item**: per-jail cgroup-v2 delegation, so each jail
> gets its own `memory.max` enforced by the kernel rather than a
> process-level `RLIMIT_AS` estimate summed by hand.

### Boot canary — fail-closed, merge- and healthcheck-blocking

On every start, the sandbox service runs a self-test jail through the exact
same `bwrap-argv.ts` path production calls use, and asserts, in order:

- the jail's network namespace has no interface at all;
- the toolchain paths are `EROFS` (write attempt fails) and any host path
  outside explicit binds is `ENOENT`;
- the configured rlimits are actually applied inside the jail (read them
  back from `/proc/self/limits` inside the jail before it exits);
- an `AF_INET` `socket()` call raises `SIGSYS` (proves the inner seccomp
  filter is loaded and doing what it claims, not merely present);
- `no_new_privs` is set;
- an attempt to create a nested user namespace (`clone`/`unshare` with
  `CLONE_NEWUSER`, and `clone3`) is killed.

**If any assertion fails, the service reports unhealthy and `/v1/execute`
refuses every request with a typed error.** There is no fallback execution
path — in-process, subprocess, or otherwise — anywhere in this design; a
sandbox that cannot prove its own isolation does not silently degrade to
running tool code unsandboxed, it stops accepting tool calls entirely.
Canary results are recorded as audit/system evidence (a `sandbox.canary`
event class), not merely logged, so "the sandbox was actually enforcing its
invariants at time T" is itself evidence, not an assumption.

### Licensing

`bwrap` (bubblewrap) is LGPL-2.0+. It is installed from Debian's package
repository and **exec'd as a distro system binary** — never linked into, or
vendored inside, any openRupiv-authored binary or library. Executing an
LGPL tool as a subprocess does not create the kind of combined/derivative
work LGPL's linking obligations are about, so this does not affect the
project's Apache-2.0 posture. For maintainers who read the project's
dependency rule more strictly than that (CLAUDE.md non-negotiable 1's
"compliant path is the default path" spirit extends, for some readers, to
license posture as well as security posture): **nsjail** (Apache-2.0,
pinned source revision, built from source at image-build time rather than
installed from a distro package) is documented here as the maintained
drop-in swap, behind the same `bwrap-argv.ts`-shaped seam — a parallel
`nsjail-argv.ts` implementing the identical builder contract. This ADR does
not adopt nsjail as the default; it commits to the seam existing so the
swap is a config change, not a redesign, if the community consensus ever
calls for it.

### Rejected alternatives

**(1) Container-per-execution via the Docker socket.** Rejected outright,
not on balance. Mounting `docker.sock` into any service is equivalent to
handing that service root on the host — a container with `docker.sock`
access can launch a `--privileged` sibling container, bind-mount `/`, and
walk away with the whole host. This is true regardless of how carefully the
*generated* per-execution containers themselves are configured; the
`docker.sock`-holding process is the actual root of trust, and it has none
of the constraints this ADR places on the sandbox service. No amount of
downstream care inside the spawned containers fixes a fundamentally
root-equivalent front door.

**(2) `nsjail`/`bwrap` run directly inside the `@openrupiv/runtime`
container.** Rejected because it forces two costs onto the wrong process.
First, unprivileged user-namespace creation requires the same seccomp/
AppArmor loosening this ADR applies to the `sandbox` service — applying
that loosening to the runtime would mean the *web-facing container holding
live OIDC session state, the audit hash-chain writer, and the OPA PDP*
now also carries the syscalls historically behind unprivileged-userns
kernel LPEs. That is exactly the container we most want to keep on the
*tightest* default profile, not the loosest. Second, it couples failure
domains that should be independent: a tool crash, a jail OOM, or a runaway
fork bomb inside a tool's execution would compete for the runtime process's
own memory/CPU/PID budget, risking control-plane availability (session
handling, policy decisions, audit writes) for a data-plane problem (one
tool call misbehaving). A dedicated sidecar keeps "the control plane is
up" and "one tool call is currently on fire" as separable facts.

**(3) gVisor or Kata Containers.** Both require host-level runtime
installation (a `runsc`/`kata-runtime` shim registered with the container
engine, and for Kata a hypervisor) before `docker compose up` can even
reach them — breaking the "clone, compose up" quickstart outright for
users on stock Docker or Docker Desktop, where installing an alternate
OCI runtime is not a one-command step. Both are adopted here as a
**documented, opt-in Phase 3 hardening**, not rejected on their security
merits (gVisor in particular narrows the unprivileged-userns kernel attack
surface this ADR's Consequences names as residual risk): the plan is
`runtime: runsc` on the `sandbox` service, shipped as a **commented-out**
Compose stanza an operator can enable once `runsc` is installed on their
host, with no change to the `bwrap-argv.ts` seam required at the
application layer since the OCI runtime swap is orthogonal to the jail
construction inside the container.

**(4) Firecracker.** Needs `/dev/kvm`, i.e., hardware virtualization
exposed to the container host — unavailable in a meaningful slice of
laptop/CI/nested-virtualization environments the quickstart targets, and
the wrong weight class for a per-tool-call sandbox at v1 scale (a microVM
per tool invocation is sized for a hosted multi-tenant tier this project is
not yet operating). Revisit if/when a hosted multi-tenant offering
(PLAN.md's "hosted multi-tenant on roadmap" line) materializes and the
per-tenant blast-radius requirement changes.

**(5) WASM Python (Pyodide / `componentize-py`).** Attractive on paper for
the air-gap/no-network story — a WASM sandbox has no syscall surface to
lock down in the first place — but rejected for two concrete reasons.
First, CPython compiled to WASM cannot run large, real-world parts of the
Python tool ecosystem this project's tools will need: native-extension
wheels, `subprocess`, real OS threads. Second, and more fundamentally,
running untrusted code **in-process** (WASM's model here is an in-process
engine, not a separate OS process) means any bug in the WASM engine itself
is a total compromise of *whichever process embeds it* — and the only
processes available to embed it in this architecture are ones already
holding session secrets and the audit-chain writer (the runtime) or a
sidecar that would then need its own separate hardening anyway, at which
point it has all of this ADR's sidecar-isolation cost with none of
bubblewrap's proven, real-OS-process isolation benefit. A kernel-level jail
around a real interpreter, in a separate process, in a separate container,
is a stronger boundary than a language-level sandbox embedded in a process
that must stay trustworthy.

## Consequences

**Threat model, most severe first — stated honestly, per CLAUDE.md's
never-claim-ahead-of-status rule:**

1. **Residual risk: kernel privilege escalation via the unprivileged-userns
   attack surface.** This is true of *every* shared-kernel isolation
   option, not a defect specific to bubblewrap — it is the reason the inner
   seccomp filter exists at all, denying the syscalls most consistently
   behind real unprivileged-userns LPEs (`mount`, `ptrace`, `bpf`,
   `keyctl`, `io_uring`, `process_vm_{read,write}v`, `open_by_handle_at`,
   `perf_event_open`, nested-userns creation including the `clone3`
   argument-inspection gap, and `AF_NETLINK` sockets). What remains after
   that allowlist is the honest residual. **This is process-level
   isolation — namespaces, seccomp, cgroups — and must never be
   represented as VM-grade isolation.** Any demonstrated escape is a
   release blocker per `specs/phase-2.md`'s "treat every escape as a
   release blocker" line, full stop, not a "file a follow-up" severity.
2. **A jail-to-sidecar escape (seccomp + namespaces both defeated) lands in
   a capless, `read_only`, internal-network-only container with no
   `docker.sock` and no route to `postgres`/`dex`/the internet** — the
   second wall described under Network above. **v1 runs all jails under
   one container-local uid**, so the blast radius of a jail-to-sidecar
   escape includes other concurrently-running jails' workspace directories
   (readable/writable by that same uid) — it is not yet per-run isolated
   at the uid level. Per-run uids are a committed Phase 3 item, not a
   promise this ADR makes good on today.
3. **Denial of service is bounded by the nested inner/outer limits above**,
   and every limit violation is audited through the runtime's existing
   `callTool` order (`ERR_SANDBOX_LIMIT` / `reason: "limit"` results flow
   through the same audit-after step as any other outcome) — this ADR adds
   no new unaudited failure path.

**Committed Phase 3 hardening**, listed here so it is a scheduled backlog
item, not an implicit promise: cgroup-v2 delegation for exact per-jail
memory/PID accounting (replacing the `RLIMIT_AS`-times-concurrency
approximation above); per-run uids (closing consequence 2's shared-uid
blast radius); Landlock as an additional LSM layer stacked with seccomp;
syscall-allowlist tightening driven by observed traces from real tool
workloads once they exist; opt-in gVisor (rejected alternative 3, promoted
to documented opt-in). **The v1 concurrency cap of 4 may itself warrant
lowering** until per-run uids land in Phase 3 — noted here rather than
silently left as a knob nobody revisits.

**Scope boundaries this ADR does not cross:** `apparmor: unconfined` and
the seccomp profile delta described under Compose wiring apply **only** to
the `sandbox` service, never to `@openrupiv/runtime` — the runtime keeps
Docker's default confinement unchanged. The `docker-seccomp.json` delta
ships as a small, diffable file in the generated workspace specifically so
an adopter's security reviewer can read exactly what was loosened and why,
without reverse-engineering it from Compose YAML. The compiled inner
seccomp BPF (`packages/sandbox/seccomp/tool.bpf`) is a versioned,
hash-pinned, CI-rebuild-diffed build artifact — the same precedent
ADR-0006 set for the committed `authz.wasm` policy bundle.

**Air-gap.** Both the `runtime` and `sandbox` images build fully
deterministically at `docker compose build` time from digest-pinned base
images, `pnpm install --frozen-lockfile`, and `pip install
--require-hashes` for the vendored wheels — nothing is ever fetched at
container *run* time. Phase 2 formally defers the air-gap *installer*
itself (`specs/phase-2.md`'s "Out" list; ENTERPRISE_READINESS.md tracks
"Air-gap installer" at M11), but this ADR's build posture does not
foreclose it or add a new network dependency that would need undoing
later.

**Human review.** This ADR, and `packages/sandbox` when it lands, are
flagged **human-review-required** per CLAUDE.md's sandbox-boundary
human-only review path. An agent session may draft `packages/sandbox` and
the generated Compose/`.env` wiring, but must not merge either
autonomously. The review-fix cycle this will very likely trigger — the
same pattern the Phase 1 security review and ADR-0006's OPA-toolchain gate
both followed — is scheduled as **M3–M4 work**, not incidental cleanup
squeezed in around it.

**Tracking.** ENTERPRISE_READINESS.md's "Sandboxed code execution" row is
updated in the same change as this ADR to point at this document and state
its real status: design decided and human-reviewed at the ADR level,
`packages/sandbox` **not yet implemented** — no claim of "shipped" or
"in progress" implementation is made until the code, tests, and human
sandbox-boundary review described here actually exist.
