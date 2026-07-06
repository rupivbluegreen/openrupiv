#!/usr/bin/env bash
# CI guard (ADR-0006): the committed authz.wasm must match authz.rego.
# Rebuilds the bundle and diffs against the committed one. If opa is not
# available, SKIP loudly rather than fail — CI stays hermetic (it loads the
# committed WASM; it does not require the toolchain to pass).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! command -v opa >/dev/null 2>&1; then
  echo "check-policy-wasm: SKIP — 'opa' not on PATH; committed authz.wasm not re-verified in this run."
  exit 0
fi

committed="policy/authz.wasm"
if [[ ! -f "$committed" ]]; then
  echo "check-policy-wasm: FAIL — committed $committed is missing." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
opa build -t wasm -e openrupiv/authz/decision -o "$tmp/bundle.tar.gz" policy/authz.rego
tar -xzf "$tmp/bundle.tar.gz" -C "$tmp"

if cmp -s "$tmp/policy.wasm" "$committed"; then
  echo "check-policy-wasm: OK — committed authz.wasm matches authz.rego."
else
  echo "check-policy-wasm: FAIL — authz.rego changed but authz.wasm is stale." >&2
  echo "  Run: pnpm --filter @openrupiv/policy build:policy   then commit policy/authz.wasm" >&2
  exit 1
fi
