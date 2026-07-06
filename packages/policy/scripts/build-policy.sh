#!/usr/bin/env bash
# Compile the Rego policy to a WASM bundle and extract the module.
#
# ADR-0006: the compiled authz.wasm is COMMITTED so CI and production load it
# without needing the opa toolchain. Run this whenever policy/authz.rego
# changes, then commit the updated authz.wasm. CI rebuilds-and-diffs when opa
# is available (scripts/check-policy-wasm.sh) to catch a stale artifact.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

if ! command -v opa >/dev/null 2>&1; then
  echo "build-policy: 'opa' not found on PATH. Install it from" >&2
  echo "  https://www.openpolicyagent.org/docs/latest/#running-opa" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Entrypoint must match what the engine evaluates (src/engine.ts).
opa build -t wasm -e openrupiv/authz/decision -o "$tmp/bundle.tar.gz" policy/authz.rego
tar -xzf "$tmp/bundle.tar.gz" -C "$tmp"
cp "$tmp/policy.wasm" policy/authz.wasm

echo "build-policy: wrote policy/authz.wasm ($(wc -c < policy/authz.wasm) bytes)"
echo "build-policy: opa $(opa version | awk '/^Version/{print $2}')"
