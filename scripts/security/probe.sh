#!/usr/bin/env sh
# Adversarial probes against a running, seeded API (Phase 10, Step 12).
#
#   sh scripts/security/probe.sh http://localhost:3100
#
# Each check asserts the *safe* outcome. It is not a penetration test — it is the
# repeatable part of the internal review: the attacks we can script, run against
# every candidate release. Findings that need judgement (business logic, data
# exposure) live in docs/security/findings.md.
set -eu

base="${1:-http://localhost:3000}"
failures=0
checks=0

pass() {
  checks=$((checks + 1))
  printf '  ok    %s\n' "$1"
}

fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  printf '  FAIL  %s\n' "$1" >&2
}

expect_status() {
  description="$1"
  expected="$2"
  actual="$3"
  case " $expected " in
    *" $actual "*) pass "$description ($actual)" ;;
    *) fail "$description (expected $expected, got $actual)" ;;
  esac
}

json_token() {
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).token??'')}catch{}})"
}

login() {
  curl -s -H "content-type: application/json" \
    -d "{\"tenantSlug\":\"$1\",\"username\":\"$2\",\"password\":\"$3\"}" \
    "$base/v1/auth/login" | json_token
}

status() {
  curl -s -o /dev/null -w '%{http_code}' "$@"
}

echo "probe: unauthenticated access"
expect_status "payments list without a token" 401 "$(status "$base/v1/payments")"
expect_status "audit log without a token" 401 "$(status "$base/v1/audit")"
expect_status "metrics without METRICS_ENABLED" 404 "$(status "$base/metrics")"

admin_token="$(login alpha-state alpha.admin alpha-admin-password)"
officer_token="$(login alpha-state alpha.officer alpha-officer-password)"
finance_token="$(login beta-state beta.finance beta-finance-password)"
# The collector holds asset:read and asset:manage; the system admin deliberately
# does not, which is why it cannot be used to read an asset below.
collector_token="$(login alpha-state alpha.collector alpha-collector-password)"
if [ -z "$admin_token" ] || [ -z "$officer_token" ] || [ -z "$finance_token" ] ||
  [ -z "$collector_token" ]; then
  echo "probe: could not sign in; is the database seeded?" >&2
  exit 2
fi

echo "probe: privilege boundaries"
expect_status "officer creating an asset" 403 \
  "$(status -X POST -H "authorization: Bearer $officer_token" -H 'content-type: application/json' \
      -d '{"assetTypeKey":"bike","attributes":{},"ownerId":"00000000-0000-0000-0000-000000000000"}' \
      "$base/v1/assets")"
expect_status "finance reading the audit log" 403 \
  "$(status -H "authorization: Bearer $finance_token" "$base/v1/audit")"
expect_status "system admin reading the ledger via reversals" 403 \
  "$(status -H "authorization: Bearer $admin_token" "$base/v1/reversals")"

echo "probe: tenant isolation"
alpha_asset="$(
  curl -s -H "authorization: Bearer $collector_token" "$base/v1/assets?limit=1" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.assets[0].id)}catch{process.stdout.write("")}})'
)"
if [ -n "$alpha_asset" ]; then
  # Denied either way: the permission check can fire before the tenant scope, so
  # the probe accepts 403 or 404 and the RLS suite proves the scope itself.
  expect_status "another tenant reading alpha's asset (403 or 404)" "403 404" \
    "$(status -H "authorization: Bearer $finance_token" "$base/v1/assets/$alpha_asset")"
  expect_status "another tenant reading alpha's sticker (403 or 404)" "403 404" \
    "$(status -H "authorization: Bearer $finance_token" "$base/v1/assets/$alpha_asset/sticker")"
else
  fail "could not read an alpha asset to test isolation"
fi

echo "probe: token integrity"
expect_status "forged QR checksum" 404 "$(status "$base/v1/verify/aaaaaaaaaaaaaaaa.deadbeef")"
expect_status "malformed QR token" 404 "$(status "$base/v1/verify/not-a-token")"
status -X POST -H "authorization: Bearer $officer_token" "$base/v1/auth/logout" >/dev/null
expect_status "revoked bearer after logout" 401   "$(status -H "authorization: Bearer $officer_token" "$base/v1/auth/me")"

echo "probe: request shape"
# A 1.2 MB payload cannot go on a command line, so it is written to a file.
big_payload="$(mktemp)"
node -e 'process.stdout.write(JSON.stringify({tenantSlug:"alpha-state",username:"a",password:"x".repeat(1200000)}))' >"$big_payload"
expect_status "body above the 1 MiB limit" 413 \
  "$(status -X POST -H 'content-type: application/json' --data-binary "@$big_payload" \
      "$base/v1/auth/login")"
rm -f "$big_payload"

echo "probe: login throttling"
for _ in 1 2 3 4 5; do
  status -X POST -H 'content-type: application/json' \
    -d '{"tenantSlug":"alpha-state","username":"probe.victim","password":"wrong"}' \
    "$base/v1/auth/login" >/dev/null
done
expect_status "sixth attempt for one username" 429 \
  "$(status -X POST -H 'content-type: application/json' \
      -d '{"tenantSlug":"alpha-state","username":"probe.victim","password":"wrong"}' \
      "$base/v1/auth/login")"

echo "probe: header spoofing does not bypass the limiter"
# `trustProxy` is off, so X-Forwarded-For cannot change the limiter's key.
expect_status "spoofed X-Forwarded-For on a throttled username" 429 \
  "$(status -X POST -H 'content-type: application/json' -H 'x-forwarded-for: 203.0.113.7' \
      -d '{"tenantSlug":"alpha-state","username":"probe.victim","password":"wrong"}' \
      "$base/v1/auth/login")"

echo
if [ "$failures" -ne 0 ]; then
  echo "probe: FAILED ($failures of $checks checks)" >&2
  exit 1
fi
echo "probe: OK ($checks checks)"
