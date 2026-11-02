#!/usr/bin/env sh
# Minimal readiness + health smoke test. Defaults to the local API base URL.
#
#   sh scripts/ci/smoke.sh http://localhost:3000
#
# Set SMOKE_ONBOARD=1 on a *fresh, disposable* deployment to also exercise the
# first-run onboarding path end to end over HTTP: status -> create tenant ->
# temporary sign-in -> credential replacement -> authenticated read -> replay
# refused. It creates a real tenant, so never point it at a deployment that is
# already in use.
set -eu

base_url="${1:-http://localhost:3000}"
deadline=$(( $(date +%s) + 60 ))

fail() {
  echo "smoke: $1" >&2
  exit 1
}

wait_for() {
  path="$1"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS "$base_url$path" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for $base_url$path" >&2
  return 1
}

json_field() {
  # json_field <body> <field>: first string value, for the flat responses here.
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

echo "smoke: waiting for $base_url/v1/health"
wait_for "/v1/health"

echo "smoke: waiting for $base_url/v1/ready"
wait_for "/v1/ready"

health="$(curl -fsS "$base_url/v1/health")"
request_id="$(curl -fsSI "$base_url/v1/health" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-request-id"{print $2}')"

printf '%s' "$health" | grep -q '"status":"ok"'
if [ -z "$request_id" ]; then
  echo "missing x-request-id header" >&2
  exit 1
fi

echo "smoke: health OK (request id: $request_id)"

if [ "${SMOKE_ONBOARD:-0}" = "1" ]; then
  echo "smoke: checking the onboarding path"

  status="$(curl -fsS "$base_url/v1/setup/status")"
  printf '%s' "$status" | grep -q '"needsSetup":true' ||
    fail "expected an unprovisioned deployment (SMOKE_ONBOARD creates a tenant)"

  slug="smoke-$(date +%s)"
  username="smoke.admin"
  password="Smoke-pass-2026"
  started=$(date +%s)

  created="$(
    curl -fsS -X POST "$base_url/v1/setup/tenant" \
      -H 'content-type: application/json' \
      -d "{\"name\":\"Smoke State\",\"slug\":\"$slug\",\"legalEntity\":\"Smoke State Revenue Authority\",\"supportEmail\":\"support@smoke.example.gov\",\"supportPhone\":\"+000000000000\",\"timezone\":\"Africa/Lagos\",\"currency\":\"NGN\",\"ussdCode\":\"*000*1#\",\"smsSenderId\":\"SMOKELEVY\",\"bikeFeeMinor\":20000,\"tuktukFeeMinor\":30000,\"adminEmail\":\"admin@smoke.example.gov\",\"languages\":[\"en\"],\"defaultLanguage\":\"en\"}"
  )"
  printf '%s' "$created" | grep -q "\"tenantSlug\":\"$slug\"" || fail "tenant was not created"

  login="$(
    curl -fsS -X POST "$base_url/v1/auth/login" \
      -H 'content-type: application/json' \
      -d "{\"tenantSlug\":\"$slug\",\"username\":\"admin\",\"password\":\"password\"}"
  )"
  token="$(json_field "$login" token)"
  [ -n "$token" ] || fail "temporary sign-in returned no token"
  printf '%s' "$login" | grep -q '"mustChangeCredentials":true' ||
    fail "temporary account was not flagged"

  completed="$(
    curl -fsS -X POST "$base_url/v1/auth/complete-onboarding" \
      -H "authorization: Bearer $token" \
      -H 'content-type: application/json' \
      -d "{\"username\":\"$username\",\"password\":\"$password\"}"
  )"
  new_token="$(json_field "$completed" token)"
  [ -n "$new_token" ] || fail "credential replacement returned no session"
  printf '%s' "$completed" | grep -q '"mustChangeCredentials":false' ||
    fail "credential step did not clear the flag"

  me="$(curl -fsS "$base_url/v1/auth/me" -H "authorization: Bearer $new_token")"
  printf '%s' "$me" | grep -q "\"roles\":\[\"system_admin\"\]" ||
    fail "the first account is not a system admin"

  after="$(curl -fsS "$base_url/v1/setup/status")"
  printf '%s' "$after" | grep -q '"needsSetup":false' || fail "setup window did not close"

  replay="$(
    curl -sS -o /dev/null -w '%{http_code}' -X POST "$base_url/v1/setup/tenant" \
      -H 'content-type: application/json' -d '{}'
  )"
  [ "$replay" = "404" ] || fail "setup replay answered $replay instead of 404"

  echo "smoke: onboarding OK (tenant $slug, $(($(date +%s) - started))s)"
fi

echo "smoke: OK"
