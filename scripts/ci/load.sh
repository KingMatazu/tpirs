#!/usr/bin/env sh
# Load smoke (Phase 10, Step 11): a short run at a quarter of the target rate.
#
#   sh scripts/ci/load.sh            # verify at 50 rps for 60 s
#   LOAD_SCENARIO=webhooks LOAD_RATE=12 sh scripts/ci/load.sh
#
# The full-rate scenarios run nightly; this is the regression gate that catches a
# query that got slower or a route that started erroring. It exits non-zero when
# a budget in docs/performance-budgets.md is breached.
set -eu

scenario="${LOAD_SCENARIO:-verify}"
rate="${LOAD_RATE:-50}"
duration="${LOAD_DURATION:-60}"

mkdir -p load-reports
sh scripts/load/run.sh "$scenario" "$rate" "$duration" \
  --json "load-reports/${scenario}-${rate}rps.json"
