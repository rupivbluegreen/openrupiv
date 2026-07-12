#!/usr/bin/env bash
# Real end-to-end isolation proof (ADR-0007). Builds the sandbox image,
# runs it with the EXACT security_opt deltas the ADR specifies, and calls
# /v1/execute against real fixture tools to prove: the boot canary passes,
# network egress is blocked (SIGSYS), filesystem escape is blocked
# (RO/ENOENT), the wall-clock limit kills a stuck jail, and the memory
# limit is enforced. If `bwrap`/user-namespace creation is not available in
# the current environment (verified via a real preflight probe, not
# assumed), this SKIPS LOUDLY rather than reporting a false pass — the
# service itself still fails closed in that case (this script's own
# "canary must be healthy" assertion is what actually enforces that).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$here"

IMAGE="openrupiv-sandbox:e2e-$$"
CONTAINER="openrupiv-sandbox-e2e-$$"
PORT=18443

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker rmi -f "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "e2e-docker: preflight — can this environment create user namespaces at all?"
# The probe exercises the SAME namespace operations the real jail uses —
# including --unshare-pid + --proc /proc, which needs systempaths=unconfined
# (Docker's default masked/locked /proc paths otherwise block an unprivileged
# nested-userns process from mounting a fresh procfs: EPERM). It binds the
# container root read-only so the target binary (/usr/bin/true) resolves —
# bwrap sets up every namespace BEFORE exec, so a bare `-- true` with nothing
# bound in fails at execvp AFTER the namespaces already succeeded, which would
# misreport a working environment as a skip. This probe now exits 0 iff the
# full mechanism the real jail depends on works.
if ! docker run --rm \
    --security-opt seccomp=packages/sandbox/docker-seccomp.json \
    --security-opt apparmor=unconfined \
    --security-opt systempaths=unconfined \
    debian:bookworm-slim bash -c "apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap >/dev/null && bwrap --unshare-user --unshare-pid --unshare-net --proc /proc --ro-bind / / --die-with-parent -- /usr/bin/true" >/tmp/e2e-preflight.log 2>&1; then
  cat /tmp/e2e-preflight.log
  # A SKIP that reports green is a FALSE proof signal. When the caller asserts
  # the proof MUST run (CI, after the runner-side
  # kernel.apparmor_restrict_unprivileged_userns=0 fix), turn the skip into a
  # hard failure so a regression surfaces as red CI, never a vacuous green.
  if [[ -n "${SANDBOX_E2E_REQUIRE_PROOF:-}" ]]; then
    echo "e2e-docker: FAIL — SANDBOX_E2E_REQUIRE_PROOF is set but this environment cannot create user namespaces, so the real isolation proof did NOT run. In CI this means the runner-side 'sysctl kernel.apparmor_restrict_unprivileged_userns=0' step is not taking effect (or bwrap hit a different namespace restriction — see the preflight log above)." >&2
    exit 1
  fi
  echo "e2e-docker: SKIP — this environment cannot create Linux user namespaces (see plan's Global Constraints). The real isolation proof requires a bwrap-capable host; set SANDBOX_E2E_REQUIRE_PROOF=1 to make this a hard failure instead of a skip."
  exit 0
fi
echo "e2e-docker: preflight OK — this environment supports the isolation mechanism."

echo "e2e-docker: building image..."
docker build -f packages/sandbox/Dockerfile -t "$IMAGE" .

TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')"
echo "e2e-docker: starting container..."
# --read-only + these two tmpfs mounts mirror the generated Compose
# `sandbox` service exactly (packages/cli/src/workspace-files.ts) — this
# is the real deployed posture, not a looser proxy for it.
docker run -d --name "$CONTAINER" \
  --read-only --tmpfs /tmp --tmpfs /workspaces:mode=1777 \
  --cap-drop ALL \
  --security-opt seccomp=packages/sandbox/docker-seccomp.json \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -e SANDBOX_TOKEN="$TOKEN" \
  -p "$PORT:8443" \
  "$IMAGE"

echo "e2e-docker: waiting for /healthz..."
ok=0
for _ in $(seq 1 30); do
  if curl -s -o /tmp/e2e-health.json -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" | grep -q 200; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "$ok" -ne 1 ]]; then
  echo "e2e-docker: FAIL — boot canary never reported healthy." >&2
  cat /tmp/e2e-health.json 2>&1 || true
  docker logs "$CONTAINER" || true
  exit 1
fi
echo "e2e-docker: boot canary healthy: $(cat /tmp/e2e-health.json)"

call() {
  local tool="$1" wall_ms="$2"
  call_input "$tool" "$wall_ms" "{}"
}

# Same as call() but with a caller-supplied JSON input object, to prove the
# supervisor delivers request input to the tool (written as input.json in the
# RW-bound workspace; the tool reads ./input.json).
call_input() {
  local tool="$1" wall_ms="$2" input="$3"
  curl -s -X POST "http://127.0.0.1:$PORT/v1/execute" \
    -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d "{\"runId\":\"$(node -e 'console.log(require("crypto").randomUUID())')\",\"tool\":\"$tool\",\"input\":$input,\"limits\":{\"wallClockMs\":$wall_ms,\"memoryBytes\":268435456,\"maxOutputBytes\":1048576}}"
}

echo "e2e-docker: echo (happy path)..."
echo_result="$(call echo 5000)"
echo "$echo_result"
echo "$echo_result" | grep -q '"ok":true' || { echo "e2e-docker: FAIL — echo did not succeed" >&2; exit 1; }

# The real v1 tool: proves input.json IS delivered to the jail and the tool's
# deterministic verdict comes back — the runtime->sidecar->jail->result path a
# governed agent task exercises (the agent leg is unit-tested with a fake
# sandbox; this is the real jail execution of the tool).
echo "e2e-docker: read-vendor-application (real tool + input delivery) — clean record must be low risk..."
low_result="$(call_input read-vendor-application 5000 '{"annualSpend":5000,"justification":"Long-standing strategic supplier for cloud infrastructure."}')"
echo "$low_result"
echo "$low_result" | grep -q '"risk":"low"' || { echo "e2e-docker: FAIL — read-vendor-application did not return low risk for a clean record (input not delivered?)" >&2; exit 1; }

echo "e2e-docker: read-vendor-application — risky record must be high risk..."
high_result="$(call_input read-vendor-application 5000 '{"annualSpend":250000,"justification":"x"}')"
echo "$high_result"
echo "$high_result" | grep -q '"risk":"high"' || { echo "e2e-docker: FAIL — read-vendor-application did not return high risk for a risky record" >&2; exit 1; }
# Delivery-discriminating: a bare "risk":"high" check is NOT enough to prove
# input delivery — the tool also returns high for a *missing* justification, so
# assess({}) (broken delivery) would still be "high" and pass the line above.
# This reason is emitted ONLY when annualSpend actually arrived in input.json,
# so it fails loudly if delivery regresses.
echo "$high_result" | grep -q 'annualSpend 250000 exceeds' || { echo "e2e-docker: FAIL — high-risk verdict missing the annualSpend reason (input field not delivered?)" >&2; exit 1; }

echo "e2e-docker: network_probe (must be blocked)..."
net_result="$(call network_probe 5000)"
echo "$net_result"
echo "$net_result" | grep -q '"violation":"network_egress"' || { echo "e2e-docker: FAIL — network egress was not blocked" >&2; exit 1; }

echo "e2e-docker: fs_probe (must be blocked)..."
fs_result="$(call fs_probe 5000)"
echo "$fs_result"
echo "$fs_result" | grep -q '"escaped":true' && { echo "e2e-docker: FAIL — filesystem escape succeeded" >&2; exit 1; }
echo "$fs_result" | grep -q '"ok":true' || { echo "e2e-docker: FAIL — fs_probe tool itself errored unexpectedly" >&2; exit 1; }

echo "e2e-docker: sleep_forever (wall clock must kill it)..."
start=$(date +%s)
sleep_result="$(call sleep_forever 3000)"
elapsed=$(( $(date +%s) - start ))
echo "$sleep_result (elapsed ${elapsed}s)"
echo "$sleep_result" | grep -q '"limit":"wall_clock"' || { echo "e2e-docker: FAIL — wall-clock limit did not fire" >&2; exit 1; }
[[ "$elapsed" -lt 10 ]] || { echo "e2e-docker: FAIL — took too long to kill (${elapsed}s)" >&2; exit 1; }

echo "e2e-docker: mem_hog (memory limit must be enforced)..."
mem_result="$(call mem_hog 10000)"
echo "$mem_result"
echo "$mem_result" | grep -q '"ok":true' && { echo "e2e-docker: FAIL — memory limit was not enforced" >&2; exit 1; }

echo "e2e-docker: ALL ASSERTIONS PASSED — real isolation proven in this environment."
