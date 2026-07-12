#!/usr/bin/env bash
# CI guard (ADR-0007): the committed tool.bpf must match
# build-tool-seccomp.c. Rebuilds and diffs against the committed one. If
# gcc/libseccomp-dev are not available, SKIP loudly rather than fail — CI
# stays hermetic (it ships the committed BPF; it does not require the
# toolchain to pass).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! command -v gcc >/dev/null 2>&1 || ! echo '#include <seccomp.h>' | gcc -E - >/dev/null 2>&1; then
  echo "check-seccomp-bpf: SKIP — gcc/libseccomp-dev not available; committed tool.bpf not re-verified in this run."
  exit 0
fi

committed="seccomp/tool.bpf"
if [[ ! -f "$committed" ]]; then
  echo "check-seccomp-bpf: FAIL — committed $committed is missing." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gcc "seccomp/build-tool-seccomp.c" -lseccomp -o "$tmp/build-tool-seccomp"
"$tmp/build-tool-seccomp" "$tmp/tool.bpf"

if cmp -s "$tmp/tool.bpf" "$committed"; then
  echo "check-seccomp-bpf: OK — committed tool.bpf matches build-tool-seccomp.c."
else
  echo "check-seccomp-bpf: FAIL — build-tool-seccomp.c changed but tool.bpf is stale." >&2
  echo "  Run: pnpm --filter @openrupiv/sandbox build:seccomp   then commit seccomp/tool.bpf" >&2
  exit 1
fi
