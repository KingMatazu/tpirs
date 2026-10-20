#!/usr/bin/env sh
# No-op deploy target.
#
# Accepts an image tag, records it, and exits successfully. It exists so the
# delivery pipeline (build -> push -> staging smoke -> deploy) is wired end to
# end from Phase 0 without depending on a chosen hosting provider.
#
# Replace by adding infra/deploy/<target>.sh and setting DEPLOY_TARGET=<target>.
set -eu

image_tag="${1:-}"

if [ -z "$image_tag" ]; then
  echo "noop deploy: missing image tag" >&2
  echo "usage: infra/deploy/noop.sh <image-tag>" >&2
  exit 2
fi

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
line="$timestamp ${image_tag}"

if [ -n "${DEPLOY_LOG_FILE:-}" ]; then
  printf '%s\n' "$line" >> "$DEPLOY_LOG_FILE"
fi

echo "noop deploy: recorded ${image_tag} at ${timestamp}"
