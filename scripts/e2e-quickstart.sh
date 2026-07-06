#!/usr/bin/env bash
# End-to-end quickstart validation against a running workspace Compose stack
# (see packages/cli — `openrupiv new` + docker compose up --build).
#
# Drives the flagship vendor-onboarding demo over real HTTP: OIDC logins via
# the bundled Dex (two distinct users), entity CRUD, and the 4-eyes workflow
# including the same-approver rejection. Exits non-zero on the first
# violated expectation.
#
# Usage: scripts/e2e-quickstart.sh [base-url]   (default http://localhost:3000)
set -euo pipefail

BASE="${1:-http://localhost:3000}"
# The browser-facing Dex issuer is http://dex:5556; rewrite that hostname to
# localhost instead of requiring an /etc/hosts entry.
CURL=(curl -sS --connect-to "dex:5556:127.0.0.1:5556")
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'E2E FAIL: %s\n' "$*" >&2; exit 1; }

json() { python3 -c "
import json,sys
doc=json.load(sys.stdin)
path='$1'.split('.')
for p in path:
    if p: doc=doc[p]
print(doc)
"; }

# login <email> <password> <cookie-jar>
login() {
  local email="$1" password="$2" jar="$3" body action
  body="$("${CURL[@]}" -c "$jar" -b "$jar" -L "$BASE/auth/login" -o - -w '')" \
    || fail "login redirect chain for $email"
  action="$(printf '%s' "$body" | grep -oE 'action="[^"]+"' | head -1 | sed 's/action="//;s/"$//;s/\&amp;/\&/g')"
  [ -n "$action" ] || fail "no login form found for $email"
  case "$action" in http*) : ;; *) action="http://dex:5556${action}" ;; esac
  "${CURL[@]}" -c "$jar" -b "$jar" -L -o /dev/null \
    --data-urlencode "login=${email}" --data-urlencode "password=${password}" \
    "$action" || fail "credential POST for $email"
  local code
  code="$("${CURL[@]}" -b "$jar" -o /dev/null -w '%{http_code}' "$BASE/api/vendor")"
  [ "$code" = "200" ] || fail "$email session not usable (GET /api/vendor -> $code)"
  echo "   logged in: $email"
}

step "health"
"${CURL[@]}" -f "$BASE/healthz" >/dev/null || fail "/healthz"

step "unauthenticated API is rejected"
CODE="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/vendor")"
[ "$CODE" = "401" ] || fail "expected 401, got $CODE"

step "OIDC logins via Dex (two distinct users)"
login dev@example.com  dev-password "$WORK/dev.jar"
login dev2@example.com dev-password "$WORK/dev2.jar"

step "create vendor + application (dev)"
VENDOR_ID="$("${CURL[@]}" -b "$WORK/dev.jar" -H 'content-type: application/json' \
  -d '{"name":"ACME GmbH","contactEmail":"sales@acme.example","country":"DE"}' \
  "$BASE/api/vendor" | json id)"
[ -n "$VENDOR_ID" ] || fail "vendor create"
APP_ID="$("${CURL[@]}" -b "$WORK/dev.jar" -H 'content-type: application/json' \
  -d "{\"vendor\":\"$VENDOR_ID\",\"justification\":\"Preferred tooling supplier\",\"annualSpend\":50000}" \
  "$BASE/api/vendor-application" | json id)"
[ -n "$APP_ID" ] || fail "application create"
STATE="$("${CURL[@]}" -b "$WORK/dev.jar" "$BASE/api/vendor-application/$APP_ID" | json status)"
[ "$STATE" = "draft" ] || fail "initial state: expected draft, got $STATE"

step "state field is read-only through the update API"
CODE="$("${CURL[@]}" -b "$WORK/dev.jar" -o "$WORK/ro.json" -w '%{http_code}' \
  -X PUT -H 'content-type: application/json' \
  -d '{"status":"approved"}' "$BASE/api/vendor-application/$APP_ID")"
[ "$CODE" = "400" ] || fail "state write should be 400, got $CODE"

step "walk the workflow: submit -> start-review (dev)"
for T in submit start-review; do
  "${CURL[@]}" -b "$WORK/dev.jar" -X POST \
    "$BASE/api/vendor-application/$APP_ID/transitions/$T" | json status >/dev/null \
    || fail "transition $T"
done

step "4-eyes: first approval (dev) -> pending 1/2"
R="$("${CURL[@]}" -b "$WORK/dev.jar" -X POST "$BASE/api/vendor-application/$APP_ID/transitions/approve")"
[ "$(printf '%s' "$R" | json status)" = "pending" ] || fail "first approve: $R"
[ "$(printf '%s' "$R" | json approvals)" = "1" ] || fail "approvals count: $R"

step "4-eyes: same-user second approval is rejected (409 ERR_DUPLICATE_APPROVER)"
CODE="$("${CURL[@]}" -b "$WORK/dev.jar" -o "$WORK/dup.json" -w '%{http_code}' \
  -X POST "$BASE/api/vendor-application/$APP_ID/transitions/approve")"
[ "$CODE" = "409" ] || fail "duplicate approver: expected 409, got $CODE"
grep -q ERR_DUPLICATE_APPROVER "$WORK/dup.json" || fail "duplicate approver body: $(cat "$WORK/dup.json")"

step "4-eyes: distinct second approver (dev2) completes the transition"
R="$("${CURL[@]}" -b "$WORK/dev2.jar" -X POST "$BASE/api/vendor-application/$APP_ID/transitions/approve")"
[ "$(printf '%s' "$R" | json status)" = "transitioned" ] || fail "second approve: $R"
STATE="$("${CURL[@]}" -b "$WORK/dev.jar" "$BASE/api/vendor-application/$APP_ID" | json status)"
[ "$STATE" = "approved" ] || fail "final state: expected approved, got $STATE"

step "SSR pages render"
"${CURL[@]}" -b "$WORK/dev.jar" -f "$BASE/p/applications" | grep -qi html || fail "/p/applications"

printf '\nE2E PASS: quickstart flow verified end-to-end (OIDC x2, CRUD, 4-eyes with duplicate-approver rejection).\n'
