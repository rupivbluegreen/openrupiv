# @openrupiv/sandbox

The bubblewrap sidecar (ADR-0007): a dedicated, unprivileged container that
runs one `bwrap` jail per agent tool execution, implementing the
`ToolSandbox` interface `@openrupiv/agents` depends on. No `docker.sock`
anywhere in this design.

Full design rationale, rejected alternatives, and the threat model:
`docs/adr/0007-agent-sandbox-bubblewrap-sidecar.md`. Contract: this package
satisfies `SandboxLimits` / `SandboxExecuteInput` / `SandboxExecuteResult` /
`ToolSandbox` exactly as already defined in `@openrupiv/agents`'s
`types.ts` -- it does not redefine or extend that contract.

## Human review required

Per CLAUDE.md's sandbox-boundary human-only review path and ADR-0007's own
"Human review" section: **this package must be reviewed and accepted by a
human maintainer before merge. No agent session may merge it
autonomously.** Everything below is written to CLAUDE.md non-negotiable
#7's standard ("never claim ahead of reality") specifically so that
reviewer can trust the status claims at face value.

## Status, honestly

- **Isolation is implemented, unit-tested, adversarially reviewed, AND now
  empirically proven green in CI** (the `sandbox-boot-canary` job). The real
  proof `scripts/e2e-docker.sh` runs actual `bwrap` jails on the hosted runner
  and asserts, end to end: the boot canary's 9 in-jail assertions pass, a
  happy-path tool executes, an `AF_INET` `socket()` is killed by the inner
  seccomp filter (the kill lands at `socket()`, before `connect()` is reached)
  and classified `violation: network_egress`, a filesystem-escape attempt is blocked
  (host path absent in the jail), the wall-clock limit kills a stuck jail
  (~3s), and the memory limit (RLIMIT_AS) is enforced. `SANDBOX_E2E_REQUIRE_PROOF=1`
  is set for that CI job so a preflight SKIP is a hard failure — the green
  check cannot be a vacuous skip.
  - Getting there required making the hosted runner behave like a normal
    unprivileged-userns Linux host: the CI job sets
    `kernel.apparmor_restrict_unprivileged_userns=0` (Ubuntu 24.04 ships it =1,
    which lets a userns be created but strips its capabilities), and the
    sandbox container runs with `systempaths=unconfined` (Docker's default
    masked/locked `/proc` paths otherwise block an unprivileged nested-userns
    process from mounting a fresh procfs — this is a Docker default on every
    host, so it is a **required production posture**, applied to the generated
    Compose service too, not just CI).
  - This package's own unit tests (`test/*.test.ts`) still inject a fake
    jail-runner (this dev sandbox cannot create user namespaces:
    `bwrap --unshare-user ...` fails with `setting up uid map: Permission
    denied`), so they exercise the server/validation/classification logic; the
    real kernel-level enforcement is what the CI e2e proves.
  - The `sandbox-seccomp` job separately rebuilds the inner-filter BPF from its
    C source on ubuntu:24.04 and diffs the committed `tool.bpf`
    (`check-seccomp-bpf: OK`).
  - **Jail `/proc` masking (closed + proven).** bubblewrap does not mask its
    OWN freshly mounted `/proc`, so the jail explicitly overmounts the
    sensitive entries (`/proc/kcore`, `/proc/keys`, `/proc/timer_list`,
    `/proc/sysrq-trigger` with `/dev/null`; `/proc/scsi` with an empty tmpfs)
    in `bwrap-argv.ts`, mirroring a subset of moby's default masked-paths list.
    The boot canary's `sensitive_proc_masked` assertion verifies from inside
    the jail that this masking is actually in effect (it passes green in run
    29171537064). `systempaths=unconfined` only unmasks the trusted
    supervisor's `/proc`, never the jail's — these are independent.
- **Now wired into the runtime end-to-end.** `serveAppDir`
  (`@openrupiv/runtime`) constructs a real `createSidecarSandbox` `ToolSandbox`
  + `AgentRuntime` whenever `SANDBOX_URL`/`SANDBOX_TOKEN` are set (absent =
  agents stay off — unchanged prior behavior). `openrupiv new` now sets both
  on the generated `runtime` service (it already joined `sandbox-internal`
  and `depends_on: sandbox`), so a generated app reaches this sidecar. The
  supervisor also now delivers the request's `input` to the tool as
  `input.json` in the RW-bound workspace (it previously parsed but dropped
  it), so tools receive real input.
- **v1 ships one real production tool: `read-vendor-application`.**
  `tools/read-vendor-application/main.py` is a real `RegisteredTool` the
  `vendor-risk-review` agent task calls: because the jail has no DB/network,
  the trusted runtime reads the VendorApplication record and passes its
  fields as input; the tool computes a deterministic onboarding-risk verdict
  and returns it, and the runtime proposes approval iff the verdict is
  low-risk. The CI e2e (`scripts/e2e-docker.sh`) runs it in a real jail and
  asserts both the low- and high-risk verdicts, proving input delivery + tool
  execution end-to-end. `/opt/vendored-wheels` stays intentionally empty (no
  third-party wheels to vendor yet); the other `tools/` entries (`canary/`,
  `echo/`, `network_probe/`, `fs_probe/`, `mem_hog/`, `sleep_forever/`) remain
  isolation fixtures, not shipped `RegisteredTool`s.

## What's here

- `src/run-id.ts`, `src/token-auth.ts` -- the two independent gates on
  `POST /v1/execute`: a strict UUID v4 check on the opaque `runId` (the
  wire never carries a trusted host path), and constant-time bearer-token
  comparison (authentication only, never authorization).
- `src/bwrap-argv.ts`, `src/entrypoint.ts` -- the one place a `bwrap` argv is
  assembled (always an array, never a shell string), and untrusted
  entrypoint-name resolution that never exec's outside its own tool root.
- `src/jail-executor.ts` -- spawns `prlimit | bwrap`, enforces the wall-clock
  timer, and classifies the outcome (violation / limit / tool_error / ok)
  from the jail's real exit code/signal, never from an in-jail self-report.
- `seccomp/` -- the inner seccomp filter: `build-tool-seccomp.c` is the
  rule source (compiled via `libseccomp`), `tool.bpf` is the committed,
  hash-pinned build artifact `scripts/check-seccomp-bpf.sh` keeps honest in
  CI (same precedent as ADR-0006's committed `authz.wasm`).
- `src/canary.ts` + `tools/canary/main.py` -- the boot canary: proves the
  isolation boundary at every startup, fails the service closed
  (`/healthz` 503s, `/v1/execute` refuses every request) if it cannot.
- `src/server.ts`, `bin/serve.mjs` -- the supervisor: exactly two routes,
  `POST /v1/execute` and `GET /healthz`.
- `src/client.ts` (exported as `createSidecarSandbox`) -- the `ToolSandbox`
  implementation `@openrupiv/agents` calls; a thin HTTP client, no policy
  logic.
- `Dockerfile`, `docker-seccomp.json`, `SECCOMP-DELTA.md` -- the image and
  the outer Compose security_opt profile (seccomp/AppArmor loosening
  bubblewrap itself needs to build a jail -- distinct from, and
  independent of, the inner filter above). `SECCOMP-DELTA.md` documents
  precisely what `docker-seccomp.json` is and how to re-diff it against a
  future moby release -- see "ADR amendments flagged for the reviewer"
  below for why it's a full profile, not the delta file the ADR text
  describes.
- `scripts/e2e-docker.sh` -- the real Docker-based end-to-end isolation
  proof, wired as CI job `sandbox-boot-canary`; `scripts/build-seccomp.sh` /
  `scripts/check-seccomp-bpf.sh` -- rebuild and CI-diff the inner filter.
- `tools/` -- `canary/` (the boot canary's own assertion script) plus
  `echo/`, `network_probe/`, `fs_probe/`, `mem_hog/`, `sleep_forever/`:
  **fixture/test tools only**, used by `test/server.test.ts` and
  `scripts/e2e-docker.sh` to prove the jail's isolation semantics. **v1
  ships zero production `RegisteredTool` implementations** -- the
  hash-pinned vendored-wheels directory (`/opt/vendored-wheels` in the
  image) is intentionally empty; there is nothing real to vendor yet.

## Scope boundary -- what this package does NOT do

This package makes the `sandbox` Compose service buildable and generatable
(`openrupiv new` writes it alongside `postgres`/`dex`/`runtime`). It does
**not** wire a real `AgentRuntime` construction (`createAgentRuntime(...,
{ sandbox: createSidecarSandbox(...) })`) into `packages/runtime`'s
generated deployment path (`bin/serve.mjs`) -- that requires a real,
concrete `RegisteredTool` catalog (a static in-code registry per
`specs/phase-2-contracts.md`'s open-question Q2), which does not exist yet
anywhere in the compiler/generator output, and a `SANDBOX_TOKEN` entry in
the generated `runtime` service's own Compose environment, which also does
not exist yet. Activating agents end-to-end in a real generated app is a
distinct, later integration task. Today: the `sandbox` service starts,
passes its own boot canary, and has no caller.

## ADR amendments flagged for the human reviewer

ADR-0007's own prose has three inconsistencies against what was actually
implemented, surfaced during the build and left here (not silently
corrected) for the human maintainer to ratify or amend alongside the code
review, per CLAUDE.md non-negotiable #7:

1. **`clone3` handling.** The ADR's authoritative seccomp rule list (under
   "A second, stricter seccomp filter applies inside the jail") is precise:
   `clone3` unconditionally returns `ENOSYS`, deliberately not
   `SECCOMP_RET_KILL_PROCESS`, because glibc's own threading code probes
   `clone3` first and falls back to plain `clone` on `ENOSYS` -- killing the
   process on that probe would break ordinary thread creation inside the
   jail, not just an attacker's attempt at a bypass. The ADR's later "Boot
   canary" section, however, loosely lists `clone3` alongside `clone`/
   `unshare` as something the canary proves gets "killed." The
   implementation (`seccomp/build-tool-seccomp.c`, `src/canary.ts`) does
   the correct thing (`ENOSYS` for `clone3`, kill for `clone`/`unshare`
   with `CLONE_NEWUSER`) -- it's the ADR's boot-canary prose that needs
   reconciling with its own seccomp section.
2. **`docker-seccomp.json` is a complete profile, not a "small diffable
   delta file."** The ADR describes the outer Compose seccomp file this
   way in two places ("Compose wiring" and "Scope boundaries"). In
   practice, Docker's `security_opt: seccomp=<file>` **replaces** the
   daemon's default profile rather than layering onto it -- an earlier
   delta-only version of this file (`defaultAction: SCMP_ACT_ERRNO`, no
   real allow rules) killed the container on its first syscall when
   applied this way (see `SECCOMP-DELTA.md` and this branch's Task 9 fix
   notes). The committed `docker-seccomp.json` is therefore necessarily
   moby v27.3.1's **complete** default profile plus one prepended 5-syscall
   allow rule (`clone`, `unshare`, `mount`, `umount2`, `pivot_root`) --
   845 lines, not a small patch fragment. `SECCOMP-DELTA.md` documents the
   actual single-rule delta and how to re-diff it against a future moby
   release; the ADR's "small diffable delta file" wording needs updating
   to match.
3. **Minor: base image codename.** The ADR's "Image and build" section
   says `python:3.12-slim-bookworm@sha256:...` but then, in the same
   sentence, refers to "Debian trixie's `bwrap` package." The pinned base
   image and the `bwrap` package actually installed are both **bookworm**
   (see `Dockerfile`) -- the ADR's "trixie" reference is a wording slip
   that should be corrected to "bookworm" for consistency with the image
   it's describing.

4. **`security_opt` delta count (third delta).** The ADR's "Isolation
   posture" section says the `sandbox` service carries **"exactly two
   documented deltas"** from Docker's defaults (the loosened seccomp profile
   and `apparmor: unconfined`). The shipped posture has **three**: the third,
   `systempaths=unconfined`, is required so each bwrap jail can mount a fresh
   `/proc` (the kernel's `mount_too_revealing()` check blocks it otherwise)
   and only unmasks the trusted supervisor's own `/proc`, never the jail's.
   The ADR's "exactly two deltas" wording needs updating to three.

5. **Non-root supervisor + `cap_drop: ALL` (applied; ADR says root).** The
   ADR describes this as "the ONE service that runs as root." It now runs as
   an **unprivileged user** (`Dockerfile` `USER 10001`) with **`cap_drop: ALL`**
   on the Compose/e2e container. A non-root process creating an unprivileged
   user namespace maps only its own single uid to root inside the jail
   (bwrap's default) and needs NO container capabilities — so the whole
   default Docker cap set (`DAC_OVERRIDE`, `NET_RAW`, `MKNOD`, `SYS_CHROOT`,
   `SETUID`/`SETGID`, …) is dropped, shrinking post-escape blast radius; bwrap
   still gets a full capability set INSIDE the jail's own userns. This
   required mounting the `/workspaces` tmpfs `mode=1777` (a tmpfs over the
   image's pre-existing dir otherwise inherits root-owned 0755, which a
   non-root supervisor can't write). The ADR's "runs as root" text needs
   updating. (Earlier attempts to `cap_drop` while still running as root
   failed with "setting up uid map: Operation not permitted" — root maps a uid
   *range* needing caps the reduced set doesn't provide; non-root avoids that.)

None of these are implementation defects -- the code does the thing the
ADR's own authoritative sections (the seccomp rule list, the Dockerfile
base) specify. They are documentation drift in the ADR's narrative prose,
called out here so the human reviewer can decide whether to amend
ADR-0007 directly or record a superseding note.

## Environment note on local verification

This package's own jail-construction unit tests (Tasks 1-8 in
`docs/superpowers/plans/2026-07-07-agent-sandbox-bwrap-sidecar.md`) never
invoke real `bwrap` -- they inject a fake jail-runner, since creating Linux
user namespaces requires a real, unnested Linux host (or a CI runner that
is one). The REAL isolation proof is `scripts/e2e-docker.sh`, wired into
CI as the `sandbox-boot-canary` job -- see that job's run history for
actual evidence the isolation boundary holds, not this README's prose. That
job now runs green with real `bwrap` jails on GitHub Actions (with
`SANDBOX_E2E_REQUIRE_PROOF=1` so a preflight skip is a hard failure, never a
vacuous green).

## Tests

```bash
corepack pnpm --filter @openrupiv/sandbox typecheck
corepack pnpm --filter @openrupiv/sandbox test
```

89 tests across 10 files, all passing locally, all against a fake
jail-runner (no real `bwrap` invoked) as described above.
