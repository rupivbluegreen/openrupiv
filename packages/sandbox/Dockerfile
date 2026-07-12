# @openrupiv/sandbox image (ADR-0007) — the bubblewrap sidecar.
#
# IMPORTANT: the build context is the MONOREPO ROOT (this package consumes
# the @openrupiv/agents workspace package for its type contract). Build:
#
#   docker build -f packages/sandbox/Dockerfile -t openrupiv-sandbox .
#
# Base is python:3.12-slim-bookworm, digest-pinned: bwrap is installed from
# Debian bookworm's own repos (never compiled from source), and Python 3.12
# + the (currently empty, v1 has no real tools yet) hash-pinned vendored
# wheels directory are what gets bound read-only INSIDE each jail. A
# separate node:22-bookworm-slim stage supplies only the `node` binary
# (verified in planning: copying just /usr/local/bin/node across these two
# same-Debian-base images works — matching glibc/libstdc++ ABI) — Node runs
# the supervisor ONLY, never tool code. No corepack/pnpm in the final
# image: production node_modules are installed in the deps stage (where
# corepack/pnpm work natively) and copied across as plain files.
#
# Digests recorded 2026-07-07 (see plan's Global Constraints for the
# verification note). Bumping either requires re-verifying the node-binary
# copy still works and updating both lines together.
FROM node:22-bookworm-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS deps
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN corepack pnpm install --frozen-lockfile --prod=false

FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b

# bwrap: the isolation mechanism itself (LGPL-2.0+, exec'd as a distro
# system binary, never linked into anything openRupiv-authored — see
# ADR-0007 "Licensing"). prlimit + util-linux: applies the fixed RLIMIT_*
# values ahead of every bwrap exec, no shell involved.
RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap util-linux \
  && rm -rf /var/lib/apt/lists/*

# Node binary only — no corepack/npm needed at runtime (see header comment).
COPY --from=deps /usr/local/bin/node /usr/local/bin/node

# The full installed workspace (node_modules + package sources), copied
# as plain files/symlinks from the deps stage — no re-install here.
WORKDIR /workspace
COPY --from=deps /workspace /workspace

# Empty hash-pinned vendored-wheels root: v1 ships zero concrete Python
# tools (packages/agents's tool registry is fixture-only so far), so there
# is honestly nothing to vendor yet. This directory exists so the RO-bind
# mechanism and the Dockerfile shape are already correct the day a real
# tool needs `pip install --require-hashes` here.
RUN mkdir -p /opt/vendored-wheels

# Committed, hash-pinned inner seccomp BPF (packages/sandbox/seccomp/tool.bpf)
# and the tool root (packages/sandbox/tools/ — currently the canary +
# integration-test fixtures only; see Task 10).
RUN mkdir -p /opt/sandbox/seccomp /opt/sandbox-tools
COPY packages/sandbox/seccomp/tool.bpf /opt/sandbox/seccomp/tool.bpf
COPY packages/sandbox/tools /opt/sandbox-tools

# python:3.12-slim's interpreter is at /usr/local/bin/python3, but the jail
# execs ${SANDBOX_PYTHON_ROOT}/bin/python3 (= /usr/bin/python3, since
# SANDBOX_PYTHON_ROOT=/usr). Symlink it there so the jail's exec resolves.
# /usr is RO-bound whole into the jail, so both this symlink and its
# /usr/local/bin target are present inside the jail.
RUN ln -sf /usr/local/bin/python3 /usr/bin/python3

ENV SANDBOX_PYTHON_ROOT=/usr \
    SANDBOX_TOOL_ROOT=/opt/sandbox-tools \
    SANDBOX_SECCOMP_BPF_PATH=/opt/sandbox/seccomp/tool.bpf \
    SANDBOX_WORKSPACE_ROOT=/workspaces \
    PORT=8443

# Harmless fallback for a bare `docker run` with no tmpfs mount. In the
# real deployed posture (Compose/e2e-docker.sh), /workspaces is a writable
# tmpfs mounted at container-start over this directory — this image-layer
# copy is masked and per-run/boot-canary subdirectories are created at
# runtime instead (see bin/serve.mjs and src/workspace.ts's createWorkspace).
RUN mkdir -p /workspaces

# Run the supervisor as an unprivileged (non-root) user. This is what lets
# the container drop ALL Linux capabilities (see the Compose/e2e
# `cap_drop: ALL`): a non-root process creating an unprivileged user
# namespace maps only its own single uid to root INSIDE the jail (bwrap's
# default), which needs NO capabilities — unlike a root process, which maps
# a uid RANGE and would require CAP_SETUID/SETGID. bwrap still gets a full
# capability set INSIDE the jail's own userns. The supervisor writes only to
# the writable tmpfs mounts (/workspaces — the Compose/e2e mounts it
# mode=1777 so uid 10001 can create per-run/boot-canary dirs — and /tmp);
# everything else in the image is read-only and world-readable.
#
# The seccomp/AppArmor deltas are applied at `docker run`/Compose time (via
# `security_opt`, not a Dockerfile directive). `docker-seccomp.json` is
# moby's default seccomp profile (pinned tag v27.3.1) verbatim PLUS exactly
# one prepended rule unconditionally allowing `clone`, `unshare`, `mount`,
# `umount2`, `pivot_root` for bubblewrap — the only diff from upstream; see
# `packages/sandbox/SECCOMP-DELTA.md`. Docker's `security_opt: seccomp=<file>`
# REPLACES the default profile rather than layering, so a "delta-only" file
# would ERRNO every syscall and kill the container on start — it must be a
# complete, functional profile.
RUN useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin sandbox
ENV HOME=/tmp
USER 10001:10001

EXPOSE 8443

HEALTHCHECK --interval=10s --timeout=5s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8443)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node --experimental-strip-types` cannot run this codebase's extensionless
# relative imports (e.g. `import { X } from "./concurrency"` in server.ts) —
# Node's type-stripping loader still applies standard ESM resolution, which
# requires an explicit specifier extension; it does not guess `.ts`. Verified
# during Task 9's build/smoke test (2026-07-11): running it against
# bin/serve.mjs threw ERR_MODULE_NOT_FOUND for "./concurrency". Falling back
# to tsx per the plan (already a root devDependency, installed by the `deps`
# stage's --prod=false install, so no new dependency). Invoke tsx's actual
# ESM CLI entry point directly with `node` — `node_modules/.bin/tsx` is a
# `/bin/sh` shim script, not JS, so `node node_modules/.bin/tsx` fails with a
# SyntaxError; `node_modules/tsx` is pnpm's real symlink into the pnpm store,
# so this path is stable across pnpm version bumps.
CMD ["node", "/workspace/node_modules/tsx/dist/cli.mjs", "/workspace/packages/sandbox/bin/serve.mjs"]
