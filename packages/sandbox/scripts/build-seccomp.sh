#!/usr/bin/env bash
# Compiles seccomp/build-tool-seccomp.c and exports the committed
# seccomp/tool.bpf (ADR-0007). Requires gcc + libseccomp-dev.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! command -v gcc >/dev/null 2>&1; then
  echo "build-seccomp: FAIL — gcc not on PATH." >&2
  exit 1
fi
if ! echo '#include <seccomp.h>' | gcc -E - >/dev/null 2>&1; then
  echo "build-seccomp: FAIL — libseccomp-dev headers not found. Install libseccomp-dev." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gcc "seccomp/build-tool-seccomp.c" -lseccomp -o "$tmp/build-tool-seccomp"
"$tmp/build-tool-seccomp" "$tmp/tool.bpf"
cp "$tmp/tool.bpf" "seccomp/tool.bpf"
echo "build-seccomp: wrote seccomp/tool.bpf ($(wc -c < seccomp/tool.bpf) bytes)"
