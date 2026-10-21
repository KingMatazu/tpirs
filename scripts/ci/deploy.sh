#!/usr/bin/env sh
# Runs the configured deploy target against an image tag.
#
# Usage: scripts/ci/deploy.sh <image-tag>
# Target selection: DEPLOY_TARGET (default: noop).
set -eu

image_tag="${1:-}"
if [ -z "$image_tag" ]; then
  echo "usage: scripts/ci/deploy.sh <image-tag>" >&2
  exit 2
fi

target="${DEPLOY_TARGET:-noop}"
script="infra/deploy/${target}.sh"

if [ ! -f "$script" ]; then
  echo "deploy target '${target}' not found at ${script}" >&2
  exit 2
fi

echo "deploying ${image_tag} via target '${target}'"
exec sh "$script" "$image_tag"
